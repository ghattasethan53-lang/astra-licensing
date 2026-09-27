import crypto from 'node:crypto';

/**
 * Signs activation credentials with Ed25519.
 *
 * The Minecraft client holds only the matching public key, so it can verify a credential is genuine
 * but cannot mint one. The private key lives in the ASTRA_SIGNING_KEY environment variable and must
 * never be committed or shipped inside the mod.
 */

let cachedKey = null;

function privateKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.ASTRA_SIGNING_KEY;
  if (!raw) {
    throw new Error('ASTRA_SIGNING_KEY is not set');
  }
  cachedKey = crypto.createPrivateKey({
    key: Buffer.from(raw.trim(), 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return cachedKey;
}

/**
 * Builds and signs a credential for one key/device pair.
 *
 * The client base64-decodes `payload`, verifies `signature` over those exact bytes, then parses the
 * JSON — so the bytes signed here and the bytes encoded here have to be identical. Serialise once.
 */
export function signCredential({ key, device }) {
  const payloadJson = JSON.stringify({
    key,
    device,
    issued: Math.floor(Date.now() / 1000),
    version: 1,
  });
  const payloadBytes = Buffer.from(payloadJson, 'utf8');
  // Ed25519 takes no separate digest algorithm, hence the null.
  const signature = crypto.sign(null, payloadBytes, privateKey());
  return {
    payload: payloadBytes.toString('base64'),
    signature: signature.toString('base64'),
  };
}

/** True if a usable signing key is configured. Used by the health check. */
export function signingReady() {
  try {
    privateKey();
    return true;
  } catch {
    return false;
  }
}
