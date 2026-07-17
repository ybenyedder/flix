// Password hashing extracted from auth.ts (which stays the public façade).
// Pure, DB-free, secret-free crypto: scrypt hashing, a constant-time verify, the
// anti-enumeration dummy work for unknown usernames, and password validation.
// No external crypto dependency — Node's crypto (scrypt) only.

import crypto from "crypto";

// scrypt cost grows with input length — cap passwords BEFORE hashing so a
// client can't ship a multi-megabyte "password" that pins the event loop in
// scryptSync. 256 chars is far beyond any real passphrase.
export const MAX_PASSWORD_LENGTH = 256;

// Fixed salt for the dummy hash below — it never verifies anything, it only
// makes the unknown-username path cost the same scrypt work as a real check.
const DUMMY_SALT = crypto.randomBytes(16).toString("hex");

export function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

/** Burn the same scrypt work for an unknown username as for a wrong password —
 *  otherwise the fast path's response time enumerates which usernames exist
 *  before a single credential is guessed. */
export function burnDummyHash(password: string): void {
  hashPassword(password, DUMMY_SALT);
}

/** Constant-time verification of `password` (with the stored `salt`) against the
 *  stored hex hash. Compares in constant time and only calls timingSafeEqual
 *  once the lengths match (it throws on a length mismatch). */
export function verifyPassword(password: string, salt: string, storedHashHex: string): boolean {
  const candidate = hashPassword(password, salt);
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(storedHashHex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function validatePassword(pw: string): string | null {
  if (!pw || pw.length < 6) return "Le mot de passe doit faire au moins 6 caractères";
  if (pw.length > MAX_PASSWORD_LENGTH) return `Le mot de passe ne doit pas dépasser ${MAX_PASSWORD_LENGTH} caractères`;
  return null;
}
