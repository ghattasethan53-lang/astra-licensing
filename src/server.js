import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import { signCredential, signingReady } from './signing.js';
import { generateKey, hashKey, maskKey, isValidFormat } from './keys.js';

/**
 * Astra licensing service.
 *
 *   Astra website  -> this API -> licence database
 *   Astra client   -> this API -> licence database
 *
 * The Minecraft server is not part of this at any point. Activation belongs to the client device.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------- rate limiting

/**
 * Small in-memory limiter. Enough to stop someone brute-forcing keys against a single instance;
 * a multi-instance deployment would want this in the database or Redis instead.
 */
const buckets = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip ?? 'unknown';
  const bucket = buckets.get(ip) ?? { count: 0, resetAt: now + WINDOW_MS };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + WINDOW_MS;
  }
  bucket.count++;
  buckets.set(ip, bucket);
  if (bucket.count > MAX_PER_WINDOW) {
    return res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Try again shortly.' });
  }
  return next();
}

// Keep the bucket map from growing without bound on a long-running instance.
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(ip);
  }
}, WINDOW_MS).unref();

// ---------------------------------------------------------------- helpers

function isDeviceHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'admin_disabled', message: 'ADMIN_TOKEN is not configured.' });
  }
  const header = req.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Constant-time compare, with a length guard because timingSafeEqual throws on a mismatch.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'unauthorized', message: 'Bad admin token.' });
  }
  return next();
}

// ---------------------------------------------------------------- client API

/**
 * Claims a key for a device and returns a signed credential.
 *
 * Re-activating with the same key on the same device is allowed and simply re-issues — that is what
 * makes a reinstall painless. A different device is refused.
 */
app.post('/api/v1/activate', rateLimit, async (req, res) => {
  try {
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    const device = req.body?.device;

    if (!isValidFormat(key)) {
      return res.status(400).json({ error: 'invalid_key', message: 'Invalid activation key.' });
    }
    if (!isDeviceHash(device)) {
      return res.status(400).json({ error: 'bad_device', message: 'Malformed device identifier.' });
    }

    const keyHash = hashKey(key);
    const existing = await db.findByHash(keyHash);
    if (!existing) {
      return res.status(404).json({ error: 'invalid_key', message: 'Invalid activation key.' });
    }
    if (existing.revoked) {
      return res.status(403).json({ error: 'revoked', message: 'This key has been revoked.' });
    }

    if (existing.device_hash === null) {
      const claimed = await db.claim(keyHash, device);
      if (!claimed) {
        // Lost a race with another activation of the same key.
        return res.status(409).json({ error: 'already_claimed', message: 'This key has already been claimed.' });
      }
      return res.json(signCredential({ key, device }));
    }

    if (existing.device_hash !== device) {
      return res.status(409).json({ error: 'device_mismatch', message: 'This key belongs to another device.' });
    }

    await db.touch(keyHash);
    return res.json(signCredential({ key, device }));
  } catch (error) {
    console.error('activate failed', error);
    return res.status(500).json({ error: 'server_error', message: 'Activation service error.' });
  }
});

/** Re-checks an existing activation. The client does not require this to start. */
app.post('/api/v1/verify', rateLimit, async (req, res) => {
  try {
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    const device = req.body?.device;
    if (!isValidFormat(key) || !isDeviceHash(device)) {
      return res.status(400).json({ valid: false, error: 'invalid_key' });
    }
    const row = await db.findByHash(hashKey(key));
    const valid = Boolean(row) && !row.revoked && row.device_hash === device;
    if (valid) await db.touch(hashKey(key));
    return res.json({ valid });
  } catch (error) {
    console.error('verify failed', error);
    return res.status(500).json({ valid: false, error: 'server_error' });
  }
});

// ---------------------------------------------------------------- admin API

/**
 * Generates keys. They are returned in full exactly once, here — only their hashes are stored, so
 * the service cannot show them again later.
 */
app.post('/api/v1/admin/keys', requireAdmin, async (req, res) => {
  try {
    const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), 200);
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : null;

    const created = [];
    const entries = [];
    for (let i = 0; i < count; i++) {
      const key = generateKey();
      created.push(key);
      entries.push({ hash: hashKey(key), masked: maskKey(key) });
    }
    await db.insertKeys(entries, note);
    return res.json({ keys: created, warning: 'Store these now. Only hashes are kept, so they cannot be shown again.' });
  } catch (error) {
    console.error('key generation failed', error);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/v1/admin/keys', requireAdmin, async (req, res) => {
  try {
    const [keys, summary] = await Promise.all([db.listKeys(), db.stats()]);
    return res.json({ keys, stats: summary });
  } catch (error) {
    console.error('listing failed', error);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/v1/admin/keys/:id/revoke', requireAdmin, async (req, res) => {
  const ok = await db.setRevoked(Number(req.params.id), req.body?.revoked !== false);
  return ok ? res.json({ ok: true }) : res.status(404).json({ error: 'not_found' });
});

/** Unbinds a key so the customer can activate on a replacement machine. */
app.post('/api/v1/admin/keys/:id/reset', requireAdmin, async (req, res) => {
  const ok = await db.resetDevice(Number(req.params.id));
  return ok ? res.json({ ok: true }) : res.status(404).json({ error: 'not_found' });
});

// ---------------------------------------------------------------- health

app.get('/healthz', async (req, res) => {
  try {
    await db.pool.query('SELECT 1');
    return res.json({ ok: true, signing: signingReady() });
  } catch {
    return res.status(503).json({ ok: false, signing: signingReady() });
  }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ---------------------------------------------------------------- start

const port = process.env.PORT || 3000;

db.migrate()
  .then(() => {
    if (!signingReady()) {
      console.warn('ASTRA_SIGNING_KEY is missing or unreadable: activation will fail until it is set.');
    }
    app.listen(port, () => console.log(`Astra licensing listening on ${port}`));
  })
  .catch((error) => {
    console.error('Database migration failed', error);
    process.exit(1);
  });
