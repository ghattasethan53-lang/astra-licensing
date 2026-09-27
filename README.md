# Astra Licensing

Licensing API and website for the Astra Minecraft client mod.

```
Astra website  ─┐
                ├─→  Licensing API  ─→  Postgres
Astra client   ─┘
```

The Minecraft **server** is not part of this at any point. Activation belongs to the Astra client
device, so a player can play single-player, join any server, switch servers or use LAN worlds without
reactivating.

## What it does

- Issues activation keys (`AST-XXXXXXXX-XXXX-XXXX`).
- Claims a key for exactly one device, identified by a hash the client computes locally.
- Returns an Ed25519-signed credential the client stores and checks offline from then on.
- Gives you a web console to generate, revoke and device-reset keys.

No Discord integration, by design.

## Deploying to Render

1. **Push this folder to a Git repository.** Confirm `.env` is not in it — it is gitignored, and it
   holds your signing key.

2. **Create the service.** In Render, choose *New → Blueprint* and point it at the repo. `render.yaml`
   provisions a free web service plus a free Postgres database and wires `DATABASE_URL` in for you.

3. **Set `ASTRA_SIGNING_KEY`.** Render will not generate this one. Paste the base64 private key from
   your local `.env` into the service's environment variables.

   To generate a fresh pair instead:

   ```bash
   node src/tools/generate-signing-key.js
   ```

   That prints a private key for this env var and a public key to paste into
   `ActivationStore` in the mod. **Rotating the key invalidates every activation already issued**, so
   only do it if the private key leaks.

4. **Grab `ADMIN_TOKEN`.** Render generates one. Copy it from the dashboard — it is how you sign in
   to `/admin`.

5. **Point the mod at your URL.** The mod defaults to `https://astra-licensing.onrender.com`. If your
   service has a different address, set `licenseApiUrl` in `.minecraft/config/astra.json`.

6. **Check it came up:** `https://your-service.onrender.com/healthz` should return
   `{"ok":true,"signing":true}`. If `signing` is `false`, `ASTRA_SIGNING_KEY` is missing or malformed.

> On Render's free tier the service sleeps when idle, so the first activation after a quiet spell can
> take 30–60 seconds to wake it. The client's timeout allows for this, but it is worth knowing before
> you assume something is broken.

## Running locally

Requires Node 20+ and a local Postgres.

```bash
npm install
cp .env.example .env    # then fill it in
npm start
```

The site is on `http://localhost:3000`, the console on `/admin`.

## Managing keys

Open `/admin` and paste your `ADMIN_TOKEN`. The token is held in that browser tab only and never
written to storage.

- **Generate** — creates keys and shows them **once**. Only hashes are stored, so a database leak
  does not hand over working licences, and the service genuinely cannot show a key again later. Copy
  them when they appear.
- **Revoke** — the key stops working at its next activation. An already-activated client keeps
  working offline until it next contacts the service.
- **Reset device** — unbinds a key so a customer can activate on a new machine. This is what you use
  when someone replaces a PC or changes hardware.

## API

### `POST /api/v1/activate`

```json
{ "key": "AST-...", "device": "<64 hex chars>" }
```

`200` returns `{"payload": "<base64>", "signature": "<base64>"}`. The client verifies the signature
against its built-in public key before trusting it, so a spoofed endpoint cannot unlock Astra.

Errors return `{"error": "<code>", "message": "..."}` with codes `invalid_key`, `already_claimed`,
`device_mismatch`, `revoked`, `rate_limited`, `bad_device`.

Re-activating the same key on the same device succeeds and re-issues — that is what makes a
reinstall painless.

### `POST /api/v1/verify`

Same body, returns `{"valid": true|false}`. The client does not need this to start.

### Admin

All require `Authorization: Bearer <ADMIN_TOKEN>`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/admin/keys` | Generate keys (`{count, note}`) |
| `GET` | `/api/v1/admin/keys` | List keys and totals |
| `POST` | `/api/v1/admin/keys/:id/revoke` | Revoke or restore (`{revoked}`) |
| `POST` | `/api/v1/admin/keys/:id/reset` | Unbind from device |

## How device binding works

The client hashes its OS, hostname and physical network adapter MACs with SHA-256 and sends only that
hash. The service never sees a MAC address or a hostname. The hash is included in the signed payload,
so it cannot be edited to match a different machine without breaking the signature — which is why
copying `activation.json` to another computer does not transfer the licence.

Two honest caveats:

- **A fingerprint can legitimately change** on the same machine — a new network adapter, a
  motherboard swap, a fresh OS install. That looks like "this key belongs to another device" to the
  customer. Device reset is the fix.
- **Client-side licensing is bypassable.** Java mods decompile cleanly, and the code that verifies the
  signature ships inside the jar that someone would be editing. This system stops casual key sharing
  and gives you a real record of who has what. It is not anti-piracy armour, and no client-side scheme
  in a Minecraft mod can be.

## Security notes

- Keys are stored as SHA-256 hashes, never plaintext.
- The admin token is compared in constant time.
- Activation and verification are rate limited per IP (20/minute). That limiter is in-memory, so if
  you ever scale past one instance, move it to the database or Redis.
- Claiming uses a conditional `UPDATE ... WHERE device_hash IS NULL` rather than check-then-write, so
  two clients racing on the same key cannot both win.
