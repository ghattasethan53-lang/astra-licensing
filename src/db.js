import pg from 'pg';

/**
 * Postgres access for the licence database.
 *
 * One table. A key is a row; claiming it writes the device hash and a timestamp. The device hash is
 * what the client computes locally — the service never sees a MAC address or a hostname.
 */

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

/**
 * Without DATABASE_URL, `pg` quietly falls back to localhost:5432 and the failure surfaces as a
 * confusing ECONNREFUSED against an address nobody configured. Say what is actually wrong instead.
 */
export function databaseConfigured() {
  return Boolean(connectionString);
}

export const pool = new Pool({
  connectionString,
  // Render's managed Postgres terminates TLS with a certificate this container does not have a
  // root for; the connection is still encrypted.
  ssl: connectionString && !connectionString.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

export async function migrate() {
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Attach a Postgres database to this service: '
      + 'create one in Render, copy its Internal Database URL, and add it as the DATABASE_URL '
      + 'environment variable. (Deploying via render.yaml as a Blueprint wires this up for you.)',
    );
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS licence_keys (
      id            SERIAL PRIMARY KEY,
      key_hash      TEXT UNIQUE NOT NULL,
      key_masked    TEXT NOT NULL,
      device_hash   TEXT,
      claimed_at    TIMESTAMPTZ,
      revoked       BOOLEAN NOT NULL DEFAULT FALSE,
      note          TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS licence_keys_device_idx ON licence_keys (device_hash);`);
}

export async function findByHash(keyHash) {
  const { rows } = await pool.query('SELECT * FROM licence_keys WHERE key_hash = $1', [keyHash]);
  return rows[0] ?? null;
}

/**
 * Claims a key for a device, but only if it is still unclaimed.
 *
 * The WHERE clause carries the "not yet claimed" condition rather than checking first and writing
 * after, so two clients racing on the same key cannot both win.
 */
export async function claim(keyHash, deviceHash) {
  const { rows } = await pool.query(
    `UPDATE licence_keys
        SET device_hash = $2, claimed_at = NOW(), last_seen_at = NOW()
      WHERE key_hash = $1 AND device_hash IS NULL AND revoked = FALSE
      RETURNING *`,
    [keyHash, deviceHash],
  );
  return rows[0] ?? null;
}

export async function touch(keyHash) {
  await pool.query('UPDATE licence_keys SET last_seen_at = NOW() WHERE key_hash = $1', [keyHash]);
}

export async function insertKeys(entries, note) {
  const inserted = [];
  for (const { hash, masked } of entries) {
    const { rows } = await pool.query(
      `INSERT INTO licence_keys (key_hash, key_masked, note)
       VALUES ($1, $2, $3)
       ON CONFLICT (key_hash) DO NOTHING
       RETURNING id`,
      [hash, masked, note ?? null],
    );
    if (rows[0]) inserted.push(rows[0].id);
  }
  return inserted;
}

export async function listKeys(limit = 200) {
  const { rows } = await pool.query(
    `SELECT id, key_masked, device_hash, claimed_at, revoked, note, created_at, last_seen_at
       FROM licence_keys
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function setRevoked(id, revoked) {
  const { rows } = await pool.query(
    'UPDATE licence_keys SET revoked = $2 WHERE id = $1 RETURNING id',
    [id, revoked],
  );
  return rows.length > 0;
}

/** Unbinds a key from its device so the customer can activate on a new machine. */
export async function resetDevice(id) {
  const { rows } = await pool.query(
    'UPDATE licence_keys SET device_hash = NULL, claimed_at = NULL WHERE id = $1 RETURNING id',
    [id],
  );
  return rows.length > 0;
}

/** Permanently removes a key. Any client holding it is locked out at its next verify. */
export async function deleteKey(id) {
  const { rows } = await pool.query('DELETE FROM licence_keys WHERE id = $1 RETURNING id', [id]);
  return rows.length > 0;
}

/**
 * Unbinds every key from its device in one statement.
 *
 * Keys stay valid and become claimable again; every client currently using one fails its next
 * verify and is asked to activate afresh.
 */
export async function resetAllDevices() {
  const { rowCount } = await pool.query(
    'UPDATE licence_keys SET device_hash = NULL, claimed_at = NULL WHERE device_hash IS NOT NULL',
  );
  return rowCount;
}

/** Deletes every key. Unrecoverable: only hashes are stored, so nothing can be reissued. */
export async function deleteAllKeys() {
  const { rowCount } = await pool.query('DELETE FROM licence_keys');
  return rowCount;
}

export async function stats() {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS total,
           COUNT(device_hash)::int AS claimed,
           COUNT(*) FILTER (WHERE revoked)::int AS revoked
      FROM licence_keys
  `);
  return rows[0];
}
