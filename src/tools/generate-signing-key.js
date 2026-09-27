import crypto from 'node:crypto';

/**
 * Generates a fresh Ed25519 signing keypair.
 *
 *   node src/tools/generate-signing-key.js
 *
 * The private key goes in the ASTRA_SIGNING_KEY environment variable on Render. The public key gets
 * pasted into PUBLIC_KEY_X509 in the mod's ActivationStore.java.
 *
 * Rotating the key invalidates every activation already issued, because existing credentials were
 * signed by the old private key and clients will be verifying with the new public one. Only do it if
 * the private key leaks.
 */

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

const publicDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const privateDer = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

// Prove the pair actually works before anyone deploys it.
const sample = Buffer.from('astra-selftest', 'utf8');
const signature = crypto.sign(null, sample, privateKey);
const verified = crypto.verify(null, sample, publicKey, signature);

console.log('ASTRA_SIGNING_KEY (private, server env var only):');
console.log(privateDer);
console.log();
console.log('PUBLIC_KEY_X509 (paste into ActivationStore.java in the mod):');
console.log(publicDer);
console.log();
console.log('self-test:', verified ? 'ok' : 'FAILED');
if (!verified) process.exit(1);
