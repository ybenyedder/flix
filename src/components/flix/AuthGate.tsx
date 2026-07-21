"use client";

// Gates the whole app behind a valid session. Only mounts `children` once
// /api/auth/status confirms an authenticated profile; otherwise renders the
// "Qui regarde ?" picker (ProfileGate). Also wires up api.onUnauthorized() so
// any later 401 (expired/revoked session) drops straight back to the picker
// without a hard page reload.
// Model: /home/pc/Documents/auralis_enterprise_grade/src/components/auralis/AuthGate.tsx

import { useEffect, type ReactNode } from "react";
import { api } from "@/lib/flix/api";
import { useProfileStore } from "@/store/profile";
import { resetProfileScopedStores } from "@/store/resetProfileScoped";
import { ProfileGate } from "./ProfileGate";

export function AuthGate({ children }: { children: ReactNode }) {
  const ready = useProfileStore((s) => s.ready);
  const authenticated = useProfileStore((s) => s.authenticated);
  const checkStatus = useProfileStore((s) => s.checkStatus);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    api.onUnauthorized(() => {
      // Same purge as the explicit logout: without it the NEXT profile to sign
      // in inherits this one's open player (which then writes its resume
      // position into the wrong account), detail modal, reco rows and state.
      void resetProfileScopedStores();
      useProfileStore.setState({ authenticated: false });
    });
    return () => api.onUnauthorized(null);
  }, []);

  if (!ready) {
    return (
      <div className="grid h-screen w-screen place-items-center bg-background">
        <span className="animate-pulse font-display text-4xl font-black tracking-tighter text-brand-gradient">FLIX</span>
      </div>
    );
  }
  if (!authenticated) return <ProfileGate />;
  return <>{children}</>;
}
