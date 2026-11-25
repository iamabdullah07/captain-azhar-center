const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PBKDF2_ITERATIONS = 100_000;

/** Generate a cryptographically random URL-safe short ID (default 9 chars). */
export function generateShortId(length = 9): string {
  const bytes = new Uint8Array(length * 2);
  let out = '';
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      // Rejection sampling to avoid modulo bias (256 -> multiple of 58 = 232)
      if (bytes[i] < 232) {
        out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
      }
    }
  }
  return out;
}

/** Generate a cryptographically random high-entropy secret token. */
export function generateRandomToken(length = 43): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const val = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(val)) {
      throw new Error('Invalid hex byte');
    }
    out[i] = val;
  }
  return out;
}

/** SHA-256 hex digest of a UTF-8 string. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

/** Constant-time byte array equality check. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/** Constant-time string comparison. */
export function constantTimeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  return constantTimeEqual(ab, bb);
}

/** Hash a password with PBKDF2-SHA-256 at 100,000 iterations and a 16-byte random salt. */
export async function hashPassword(password: string, existingSaltHex?: string): Promise<{ hashHex: string; saltHex: string }> {
  const salt = existingSaltHex
    ? hexToBytes(existingSaltHex)
    : crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  return {
    hashHex: bytesToHex(new Uint8Array(derivedBits)),
    saltHex: bytesToHex(salt),
  };
}

/** Verify password against stored PBKDF2 hash and salt in constant time. */
export async function verifyPassword(password: string, storedHashHex: string, saltHex: string): Promise<boolean> {
  if (!storedHashHex || !saltHex) return false;
  try {
    const { hashHex } = await hashPassword(password, saltHex);
    return constantTimeEqual(hexToBytes(hashHex), hexToBytes(storedHashHex));
  } catch {
    return false;
  }
}

/** Sign an arbitrary payload string using HMAC-SHA256. */
export async function hmacSign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return bytesToHex(new Uint8Array(sig));
}

/** Verify an HMAC-signed token formatted as `<rawId>.<sigHex>`. */
export async function verifySignedSessionToken(token: string, secret: string): Promise<boolean> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const payload = token.slice(0, dot);
  const sigHex = token.slice(dot + 1);
  if (!/^[a-f0-9]{64}$/i.test(sigHex)) return false;
  const expected = await hmacSign(payload, secret);
  return constantTimeEqualStr(sigHex.toLowerCase(), expected.toLowerCase());
}

/** Create a signed session token (`<id>.<hmac>`) and its SHA-256 storage hash. */
export async function createSessionToken(secret: string): Promise<{ token: string; tokenHash: string }> {
  const rawId = generateRandomToken(32);
  const sig = await hmacSign(rawId, secret);
  const token = `${rawId}.${sig}`;
  const tokenHash = await sha256Hex(token);
  return { token, tokenHash };
}
