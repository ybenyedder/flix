// Purge every per-profile store in one place. Used by BOTH sign-out paths:
// the explicit logout menu action (Header) AND the api.onUnauthorized() 401
// callback (AuthGate). The 401 path previously reset nothing, so the next
// profile inherited the previous one's open player — which then wrote ITS
// resume position into the wrong account — plus the detail modal, search,
// reco rows, personal state and live séance SSE.

import { usePlayerStore } from "./player";
import { useUiStore } from "./ui";
import { useRecoStore } from "./reco";
import { useStateStore } from "./state";
import { useWatchPartyStore } from "./watchParty";

/** Returns leave()'s promise so the logout path can await the séance's
 *  best-effort server notification BEFORE invalidating the session (the 401
 *  path just fire-and-forgets it — the session is already dead there, and
 *  leave() tears down its SSE/local state synchronously anyway). */
export function resetProfileScopedStores(): Promise<void> {
  const left = useWatchPartyStore.getState().leave();
  usePlayerStore.getState().close();
  useUiStore.getState().closeDetail();
  useUiStore.getState().setSearchQuery("");
  useUiStore.getState().navigate("home");
  useRecoStore.getState().reset();
  useStateStore.getState().reset();
  return left;
}
