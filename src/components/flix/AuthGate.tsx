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
import { ProfileGate } from "./ProfileGate";

export function AuthGate({ children }: { children: ReactNode }) {
  const ready = useProfileStore((s) => s.ready);
  const authenticated = useProfileStore((s) => s.authenticated);
  const checkStatus = useProfileStore((s) => s.checkStatus);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    api.onUnauthorized(() => useProfileStore.setState({ authenticated: false }));
    return () => api.onUnauthorized(null);
  }, []);

  if (!ready) {
    return (
      <div className="grid h-screen w-screen place-items-center bg-background">
        <span className="text-2xl font-display font-black tracking-tight text-accent">FLIX</span>
      </div>
    );
  }
  if (!authenticated) return <ProfileGate />;
  return <>{children}</>;
}
