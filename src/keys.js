import crypto from 'node:crypto';

/**
 * Activation key generation and hashing.
 *
 * Keys look like AST-XXXXXXXX-XXXX-XXXX, but the client only enforces the general shape (an AST
 * prefix and at least three separators), so section lengths can change later without breaking
 * clients that are already in the wild.
 */

// No look-alike characters: 0/O and 1/I/l are left out so keys survive being read aloud or retyped.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const SECTION_LENGTHS = [8, 4, 4];

export const KEY_PREFIX = 'AST';

/** Cryptographically random section of the given length. */
function randomSection(length) {
  const bytes = crypto.randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length; i++) {
    // Rejection sampling keeps the distribution even across the alphabet.
    const value = bytes[i % bytes.length];
    if (value < Math.floor(256 / ALPHABET.length) * ALPHABET.length) {
      out += ALPHABET[value % ALPHABET.length];
    } else if (i > bytes.length * 1.5) {
      out += ALPHABET[crypto.randomInt(ALPHABET.length)];
    }
  }
  return out;
}

export function generateKey() {
  return [KEY_PREFIX, ...SECTION_LENGTHS.map(randomSection)].join('-');
}

/**
 * Keys are stored hashed, never in plaintext, so a database leak does not hand over working
 * licences. The trade-off is that a key can only ever be shown once, at creation.
 */
export function hashKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Display form that identifies a key in listings without revealing it. */
export function maskKey(key) {
  const parts = key.split('-');
  const tail = parts.length > 1 ? parts[parts.length - 1] : '';
  return `${KEY_PREFIX}-***-${tail}`;
}

/**
 * Same rules the Minecraft client applies: AST prefix, at least three separators, non-empty
 * alphanumeric sections. Deliberately independent of the lengths used by generateKey().
 */
export function isValidFormat(raw) {
  if (typeof raw !== 'string') return false;
  const key = raw.trim();
  if (!key) return false;
  const parts = key.split('-');
  if (parts.length < 4) return false;
  if (parts[0] !== KEY_PREFIX) return false;
  return parts.slice(1).every((section) => /^[A-Za-z0-9]+$/.test(section));
}
