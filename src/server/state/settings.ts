// Per-profile settings, backed by the user_settings key/value table
// ((user_id, key) PK — rows are purged by auth.ts when the profile is
// deleted). Current keys: the playback language preferences pref.audioLang /
// pref.subtitleLang that decide() uses to preselect tracks. Values are
// validated BOTH on write (the /api/settings route rejects anything invalid)
// and on read (a hand-edited or corrupted row degrades to "no preference",
// never to a crash or a weird preselection).

import { getDb } from "../db";

/** user_settings keys for the playback language preferences. */
export const PREF_AUDIO_LANG = "pref.audioLang";
export const PREF_SUBTITLE_LANG = "pref.subtitleLang";

/** ISO-639-ish language code as the library stores them: 2-3 lowercase
 *  letters ("fr", "fre", "fra", "eng"…). Strict on purpose — these values are
 *  echoed back into playback decisions, so garbage must never round-trip. */
const LANG_CODE_RE = /^[a-z]{2,3}$/;

export function isValidLangCode(value: unknown): value is string {
  return typeof value === "string" && LANG_CODE_RE.test(value);
}

/** Subtitle preference: a language code, or "off" (« Désactivés » persisted). */
export function isValidSubtitlePref(value: unknown): value is string {
  return value === "off" || isValidLangCode(value);
}

export function getUserSetting(userId: number, key: string): string | null {
  const row = getDb().prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = ?").get(userId, key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

/** Upsert one setting; null deletes the row (an absent key IS the default). */
export function setUserSetting(userId: number, key: string, value: string | null): void {
  const db = getDb();
  if (value === null) {
    db.prepare("DELETE FROM user_settings WHERE user_id = ? AND key = ?").run(userId, key);
  } else {
    db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value").run(userId, key, value);
  }
}

export interface PlaybackPrefs {
  /** Preferred audio language code, or null (no preference). */
  audioLang: string | null;
  /** Preferred subtitle language code, "off" (explicitly none), or null. */
  subtitleLang: string | null;
}

export function getPlaybackPrefs(userId: number): PlaybackPrefs {
  const audioLang = getUserSetting(userId, PREF_AUDIO_LANG);
  const subtitleLang = getUserSetting(userId, PREF_SUBTITLE_LANG);
  return {
    audioLang: isValidLangCode(audioLang) ? audioLang : null,
    subtitleLang: isValidSubtitlePref(subtitleLang) ? subtitleLang : null,
  };
}

/** Apply a partial preference update: an undefined field is left untouched, a
 *  null one is cleared, and anything else must pass the strict validators
 *  above — one invalid field rejects the whole write (nothing is clobbered). */
export function setPlaybackPrefs(userId: number, prefs: { audioLang?: unknown; subtitleLang?: unknown }): { ok: boolean; error?: string } {
  let audioLang: string | null | undefined;
  if (prefs.audioLang !== undefined) {
    if (prefs.audioLang !== null && !isValidLangCode(prefs.audioLang)) return { ok: false, error: "audioLang invalide" };
    audioLang = prefs.audioLang;
  }
  let subtitleLang: string | null | undefined;
  if (prefs.subtitleLang !== undefined) {
    if (prefs.subtitleLang !== null && !isValidSubtitlePref(prefs.subtitleLang)) return { ok: false, error: "subtitleLang invalide" };
    subtitleLang = prefs.subtitleLang;
  }
  if (audioLang !== undefined) setUserSetting(userId, PREF_AUDIO_LANG, audioLang);
  if (subtitleLang !== undefined) setUserSetting(userId, PREF_SUBTITLE_LANG, subtitleLang);
  return { ok: true };
}
