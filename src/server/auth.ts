// Multi-profile authentication for the self-hosted server. Accounts live in the
// `users` table and double as Netflix-style "profiles" (avatar, kids flag) — the
// admin (seeded on first run) can create more profiles, and each gets its own
// list / ratings / progress / recommendations. Sessions are signed HMAC tokens
// carrying the user id; they are accepted as a cookie OR as a bearer / ?token=
// (so WebView/native clients that persist the token in localStorage stay logged
// in across restarts). An optional FLIX_TOKEN bearer maps to the admin.
//
// No external crypto dependency — Node's crypto (scrypt + HMAC) only.
//
// This file is the public FAÇADE: the password-hashing primitives live in
// ./authparts/passwords and the session-token/cookie helpers in
// ./authparts/sessions. The signing secret, its per-connection memoisation and
// the admin-seed (ensureAuth) stay here because they are keyed on the live DB
// connection identity — the sessions module receives `sign` as a callback so it
// never has to move that state.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getDb } from "./db";
import { getConfig } from "./config";
import { createLogger } from "./logger";
import { invalidateReco } from "./reco/engine";
import { MAX_PASSWORD_LENGTH, hashPassword, burnDummyHash, verifyPassword, validatePassword } from "./authparts/passwords";
import {
  COOKIE_NAME,
  SESSION_TTL_MS,
  matchesAuthToken,
  encodeSessionToken,
  decodeSessionToken,
  parseCookie,
  extractBearer,
} from "./authparts/sessions";

const log = createLogger("auth");
const DEFAULT_ADMIN = "admin";

export interface UserRow {
  id: number;
  username: string;
  is_admin: number;
  is_default: number;
  is_kids: number;
  avatar: string;
  created_at: number;
}

const USER_COLUMNS = "id, username, is_admin, is_default, is_kids, avatar, created_at";

function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
function setSetting(key: string, value: string): void {
  getDb().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// Hot-path memoisation: ensureAuth() (SELECT settings + COUNT users) and the
// signing-secret lookup used to run on EVERY authenticated request (~4 SQL
// queries per API call), yet the secret never changes once seeded and the seed
// itself is idempotent. Both memos are keyed on the live DB connection object,
// so tests (or the desktop app) that close and recreate the DB get a fresh
// seed/secret automatically instead of reusing state from a previous file.
let seededConn: unknown = null;
let secretConn: unknown = null;
let cachedSecret = "";

/** Seed the signing secret and the first admin account. Idempotent, and a
 *  no-op after the first success on the current DB connection. */
export function ensureAuth(): void {
  const db = getDb();
  if (db === seededConn) return;
  if (!getSetting("auth.secret")) {
    setSetting("auth.secret", crypto.randomBytes(32).toString("hex"));
  }
  const count = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  if (count > 0) {
    seededConn = db;
    return;
  }

  const salt = crypto.randomBytes(16).toString("hex");
  // Never ship a known default password. An operator-supplied password (env) is
  // used verbatim; otherwise we generate a random one. We must NOT log the
  // generated password through the structured logger — stdout/JSON logs are
  // routinely shipped to collectors and shared, so a plaintext admin secret
  // there is a real exposure. Instead we write it to a 0600 file in the data
  // dir and only log WHERE to read it.
  const envPw = process.env.FLIX_ADMIN_PASSWORD?.trim();
  // A set-but-too-short FLIX_ADMIN_PASSWORD (< 6 chars) must be treated as "no
  // env password" for the purpose of surfacing the credential: if we keyed the
  // branch below off `envPw` alone, a truthy-but-invalid value would set
  // isDefault=0 AND skip the file-write/log, so the random password we actually
  // hash would never be surfaced → permanent admin lockout. Collapse it to null
  // and drive initialPw / isDefault / the surfacing branch off `usableEnvPw`.
  const usableEnvPw = envPw && envPw.length >= 6 ? envPw : null;
  // Tell the operator WHY their password didn't take, so a silent fallback to a
  // generated password isn't mistaken for the env value being honoured.
  if (envPw && !usableEnvPw) {
    log.warn(
      "FLIX_ADMIN_PASSWORD was set but ignored — it must be at least 6 characters. " +
        "Falling back to a generated admin password (see the notice below).",
    );
  }
  const initialPw = usableEnvPw ?? crypto.randomBytes(9).toString("base64url");
  const hash = hashPassword(initialPw, salt);
  const isDefault = usableEnvPw ? 0 : 1;
  if (!usableEnvPw) {
    let where = "(impossible d'écrire le fichier)";
    try {
      const file = path.join(getConfig().dataDir, "INITIAL_ADMIN_PASSWORD.txt");
      fs.writeFileSync(
        file,
        `Flix — compte admin initial\nutilisateur: ${DEFAULT_ADMIN}\nmot de passe: ${initialPw}\n\n` +
          `Connectez-vous, changez ce mot de passe, puis supprimez ce fichier.\n`,
        { mode: 0o600 },
      );
      try { fs.chmodSync(file, 0o600); } catch { /* best-effort on platforms without POSIX modes */ }
      where = file;
    } catch {
      /* data dir not writable — fall through with the notice below */
    }
    log.warn(
      "No admin account found — generated a temporary admin password. " +
        `It was written to ${where}. Log in, change it, then delete that file ` +
        "(or set FLIX_ADMIN_PASSWORD to avoid this).",
      { username: DEFAULT_ADMIN },
    );
  }
  db.prepare(
    "INSERT INTO users (username, password_hash, password_salt, is_admin, is_default, avatar, created_at) VALUES (?, ?, ?, 1, ?, 'red', ?)",
  ).run(DEFAULT_ADMIN, hash, salt, isDefault, Date.now());
  seededConn = db;
}

function secret(): string {
  const db = getDb();
  if (db === secretConn && cachedSecret) return cachedSecret;
  ensureAuth();
  const value = getSetting("auth.secret");
  if (!value) throw new Error("auth secret not initialised");
  cachedSecret = value;
  secretConn = db;
  return value;
}

export function getUserById(id: number): UserRow | null {
  return (getDb().prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as UserRow | undefined) ?? null;
}

export function getUserByName(username: string): UserRow | null {
  return (getDb().prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?`).get(username) as UserRow | undefined) ?? null;
}

/** Verify a username/password pair. Returns the user row on success, else null. */
export function verifyCredentials(username: string, password: string): UserRow | null {
  ensureAuth();
  if (password.length > MAX_PASSWORD_LENGTH) return null; // cap BEFORE scrypt (see MAX_PASSWORD_LENGTH)
  const row = getDb()
    .prepare(`SELECT ${USER_COLUMNS}, password_hash, password_salt FROM users WHERE username = ?`)
    .get(username) as (UserRow & { password_hash: string; password_salt: string }) | undefined;
  if (!row) {
    // Burn the same scrypt work for an unknown username as for a wrong
    // password — otherwise the fast path's response time enumerates which
    // usernames exist before a single credential is guessed.
    burnDummyHash(password);
    return null;
  }
  if (!verifyPassword(password, row.password_salt, row.password_hash)) return null;
  const { password_hash: _h, password_salt: _s, ...user } = row;
  return user;
}

function normalizeUsername(name: string): string {
  return name.trim().toLowerCase();
}

export const AVATAR_PRESETS = ["red", "blue", "green", "purple", "orange", "teal", "pink", "yellow"] as const;

function normalizeAvatar(avatar: string | undefined): string {
  return avatar && (AVATAR_PRESETS as readonly string[]).includes(avatar) ? avatar : "red";
}

export interface CreateUserOptions {
  isAdmin?: boolean;
  avatar?: string;
  isKids?: boolean;
}

export function createUser(username: string, password: string, opts: CreateUserOptions = {}): { ok: boolean; error?: string; id?: number } {
  ensureAuth();
  const uname = normalizeUsername(username);
  if (!/^[a-z0-9._-]{2,32}$/.test(uname)) return { ok: false, error: "Identifiant invalide (2–32 caractères : lettres, chiffres, . _ -)" };
  const pwErr = validatePassword(password);
  if (pwErr) return { ok: false, error: pwErr };
  if (getUserByName(uname)) return { ok: false, error: "Cet identifiant existe déjà" };
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  const info = getDb()
    .prepare(
      "INSERT INTO users (username, password_hash, password_salt, is_admin, is_default, is_kids, avatar, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
    )
    .run(uname, hash, salt, opts.isAdmin ? 1 : 0, opts.isKids ? 1 : 0, normalizeAvatar(opts.avatar), Date.now());
  return { ok: true, id: Number(info.lastInsertRowid) };
}

export function listUsers(): UserRow[] {
  ensureAuth();
  return getDb().prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY id ASC`).all() as UserRow[];
}

export function updateProfile(id: number, updates: { avatar?: string; isKids?: boolean }): { ok: boolean; error?: string } {
  if (!getUserById(id)) return { ok: false, error: "Profil introuvable" };
  if (updates.avatar !== undefined) {
    getDb().prepare("UPDATE users SET avatar = ? WHERE id = ?").run(normalizeAvatar(updates.avatar), id);
  }
  if (updates.isKids !== undefined) {
    getDb().prepare("UPDATE users SET is_kids = ? WHERE id = ?").run(updates.isKids ? 1 : 0, id);
    // The reco engine's per-user cache is keyed on userId alone (it reads the
    // fresh is_kids flag from the request on every call, but memoises the
    // scored catalogue) — flipping the flag must drop that memo immediately,
    // or a just-converted kids profile could see one cached window of
    // unfiltered scores/rows.
    invalidateReco(id);
  }
  return { ok: true };
}

export function deleteUser(id: number): { ok: boolean; error?: string } {
  const db = getDb();
  const target = getUserById(id);
  if (!target) return { ok: false, error: "Profil introuvable" };
  if (target.is_admin) {
    const admins = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").get() as { n: number }).n;
    if (admins <= 1) return { ok: false, error: "Impossible de supprimer le dernier administrateur" };
  }
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM progress WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM watch_events WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM my_list WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM ratings WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_settings WHERE user_id = ?").run(id);
    // arr_requests.user_id has no FK cascade, so deleting the profile without
    // this leaves orphaned download-request rows pointing at a gone user.
    db.prepare("DELETE FROM arr_requests WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  });
  tx();
  // The deleted profile may still have a live ffmpeg session; kill it so the
  // account's removal doesn't leave an orphaned encoder streaming on its
  // behalf. Dynamically imported (same pattern as db.ts's shutdown hook and
  // the logout route) so auth never takes a hard dependency on playback.
  void import("./playback/sessions")
    .then((m) => m.killSessionsForUser(id))
    .catch(() => {});
  return { ok: true };
}

/** Set a new password for a user (admin reset or self-change). */
export function setUserPassword(userId: number, newPassword: string): { ok: boolean; error?: string } {
  const pwErr = validatePassword(newPassword);
  if (pwErr) return { ok: false, error: pwErr };
  if (!getUserById(userId)) return { ok: false, error: "Profil introuvable" };
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(newPassword, salt);
  // Bump token_version so every session token issued before this password change
  // stops validating (a leaked 30-day token can't outlive a password reset).
  getDb().prepare("UPDATE users SET password_hash = ?, password_salt = ?, is_default = 0, token_version = token_version + 1 WHERE id = ?").run(hash, salt, userId);
  return { ok: true };
}

/** Self password change — requires the current password. */
export function changePassword(userId: number, currentPassword: string, newPassword: string): { ok: boolean; error?: string } {
  const user = getUserById(userId);
  if (!user) return { ok: false, error: "Profil introuvable" };
  if (!verifyCredentials(user.username, currentPassword)) return { ok: false, error: "Mot de passe actuel incorrect" };
  return setUserPassword(userId, newPassword);
}

export function isDefaultPassword(userId: number): boolean {
  return getUserById(userId)?.is_default === 1;
}

function sign(data: string): string {
  return crypto.createHmac("sha256", secret()).update(data).digest("base64url");
}

/** Current session-token version for a user (bumped on password change to revoke
 *  every token issued before it). Missing column / row → 0. */
function getTokenVersion(userId: number): number {
  try {
    const row = getDb().prepare("SELECT token_version FROM users WHERE id = ?").get(userId) as { token_version: number } | undefined;
    return row?.token_version ?? 0;
  } catch {
    return 0;
  }
}

export function createSessionToken(userId: number): string {
  return encodeSessionToken(userId, getTokenVersion(userId), sign);
}

/** The first admin account — the identity the static FLIX_TOKEN maps to. */
function firstAdmin(): UserRow | null {
  return (getDb().prepare(`SELECT ${USER_COLUMNS} FROM users WHERE is_admin = 1 ORDER BY id ASC LIMIT 1`).get() as UserRow | undefined) ?? null;
}

/** A decoded session token → its user, rejecting a stale token version (one
 *  issued before a password change). Null for an absent/invalid/stale token. */
function userForToken(decoded: ReturnType<typeof decodeSessionToken>): UserRow | null {
  if (!decoded) return null;
  const user = getUserById(decoded.uid);
  return user && getTokenVersion(user.id) === decoded.tv ? user : null;
}

/** Resolve the authenticated user for a request (cookie, bearer/?token=, or the
 *  static FLIX_TOKEN which maps to the first admin). Returns null if none. */
export function getRequestUser(request: Request): UserRow | null {
  ensureAuth();
  const cookie = parseCookie(request.headers.get("cookie"), COOKIE_NAME);
  const bearer = extractBearer(request);
  const queryToken = new URL(request.url).searchParams.get("token");

  const user = userForToken(decodeSessionToken(cookie, sign) ?? decodeSessionToken(bearer, sign) ?? decodeSessionToken(queryToken, sign));
  if (user) return user;

  const { authToken } = getConfig();
  if (authToken && matchesAuthToken(authToken, bearer, queryToken)) return firstAdmin();
  return null;
}

/** Resolve the authenticated user from a request's bearer / ?token= ONLY — the
 *  session cookie is deliberately ignored. Used by the CSRF guard: a cookie is
 *  auto-attached by the browser (the CSRF vector), whereas a bearer / ?token= is
 *  never sent automatically, so a request that authenticates *purely* via a valid
 *  token can be safely exempted. A merely *present* (but forged/expired/stale)
 *  token returns null here. The ONLY difference from getRequestUser: no cookie. */
export function getTokenUser(request: Request): UserRow | null {
  ensureAuth();
  const bearer = extractBearer(request);
  const queryToken = new URL(request.url).searchParams.get("token");

  const user = userForToken(decodeSessionToken(bearer, sign) ?? decodeSessionToken(queryToken, sign));
  if (user) return user;

  const { authToken } = getConfig();
  if (authToken && matchesAuthToken(authToken, bearer, queryToken)) return firstAdmin();
  return null;
}

export function isAuthenticated(request: Request): boolean {
  return getRequestUser(request) !== null;
}

export const SESSION_COOKIE = COOKIE_NAME;
export const SESSION_MAX_AGE_S = Math.floor(SESSION_TTL_MS / 1000);

/** Cookie options for the session cookie, shared by every route that sets it so
 *  the flags never drift apart. `Secure` is added whenever the request arrived
 *  over HTTPS (directly or via a terminating reverse proxy that sets
 *  X-Forwarded-Proto), so the 30-day session token is never sent back in clear
 *  once the deployment is served over TLS — while plain-HTTP LAN installs still
 *  work (a Secure cookie would be dropped there and lock the user out). */
export function sessionCookieOptions(request: Request): {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  maxAge: number;
  secure: boolean;
} {
  let https = false;
  try {
    https = new URL(request.url).protocol === "https:";
  } catch {
    /* malformed URL — treat as non-HTTPS */
  }
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto && forwardedProto.split(",")[0].trim().toLowerCase() === "https") https = true;
  return { httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE_S, secure: https };
}
