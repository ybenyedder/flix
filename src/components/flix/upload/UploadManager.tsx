"use client";

// Wires the whole upload feature into the shell: window-level drag/drop
// detection (admin only, suspended during playback), a one-time capability
// probe, a beforeunload guard while transfers are in flight, and mounting of
// the drop overlay + dock. Rendered once inside FlixShell.

import { useEffect, useRef } from "react";
import { useUploadStore } from "@/store/upload";
import { useProfileStore } from "@/store/profile";
import { usePlayerStore } from "@/store/player";
import { UploadDropOverlay } from "@/components/flix/upload/UploadDropOverlay";
import { UploadDock } from "@/components/flix/upload/UploadDock";

export function UploadManager() {
  const isAdmin = useProfileStore((s) => s.isAdmin);
  const authenticated = useProfileStore((s) => s.authenticated);
  const playing = usePlayerStore((s) => s.request);
  const loadCapability = useUploadStore((s) => s.loadCapability);
  const setDragActive = useUploadStore((s) => s.setDragActive);
  const enqueue = useUploadStore((s) => s.enqueue);

  const capabilityLoaded = useUploadStore((s) => s.capabilityLoaded);
  const dragDepth = useRef(0);

  // Probe write capability + resumable sessions once, when an admin is present.
  useEffect(() => {
    if (isAdmin && authenticated && !capabilityLoaded) void loadCapability();
  }, [isAdmin, authenticated, capabilityLoaded, loadCapability]);

  // Warn before leaving while a transfer is running (the File handle can't be
  // rehydrated after a reload, so an in-flight upload would have to restart).
  useEffect(() => {
    if (!isAdmin) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const busy = useUploadStore.getState().items.some((it) => it.status === "uploading" || it.status === "finalizing");
      if (busy) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isAdmin]);

  // Drag/drop is only meaningful for admins, and is suspended while the player
  // owns the screen.
  useEffect(() => {
    if (!isAdmin || playing) return;

    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragActive(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) enqueue(files);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      dragDepth.current = 0;
      setDragActive(false);
    };
  }, [isAdmin, playing, setDragActive, enqueue]);

  if (!isAdmin) return null;

  return (
    <>
      <UploadDropOverlay />
      <UploadDock />
    </>
  );
}
