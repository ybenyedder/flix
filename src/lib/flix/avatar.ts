// Client-safe mirror of the AVATAR_PRESETS list in src/server/auth.ts (that
// module pulls in node:crypto/fs and can't be imported from client
// components). Keep the two lists in sync if presets ever change.

export const AVATAR_PRESETS = ["red", "blue", "green", "purple", "orange", "teal", "pink", "yellow"] as const;
export type AvatarPreset = (typeof AVATAR_PRESETS)[number];

const GRADIENTS: Record<AvatarPreset, [string, string]> = {
  red: ["#e50914", "#7a0509"],
  blue: ["#2196f3", "#0c3d78"],
  green: ["#43a047", "#1b5e20"],
  purple: ["#8e24aa", "#4a148c"],
  orange: ["#fb8c00", "#a35400"],
  teal: ["#00897b", "#00332d"],
  pink: ["#d81b60", "#6e0e30"],
  yellow: ["#fdd835", "#a68500"],
};

/** [base, shadow] gradient stops for an avatar preset name — unknown/missing
 *  presets fall back to red, same as the server's normalizeAvatar(). */
export function avatarGradient(preset: string | null | undefined): [string, string] {
  return GRADIENTS[(preset ?? "red") as AvatarPreset] ?? GRADIENTS.red;
}
