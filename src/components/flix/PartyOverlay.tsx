"use client";

// In-player watch-party ("Séance") chrome: who's in the room, floating emoji
// reactions, a quick-reaction bar and a collapsible chat. Purely presentational
// over the watchParty store — all the sync logic lives in PlayerView + the
// store. The presence pill and action bar ride the player's own controls
// visibility so they fade with everything else; reactions always float.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Crown, MessageCircle, Send, X, Users } from "lucide-react";
import { useWatchPartyStore } from "@/store/watchParty";
import { ProfileAvatar } from "./ProfileGate";

const QUICK_REACTIONS = ["❤️", "😂", "😮", "😢", "🔥", "👏", "🎬"];

export function PartyOverlay({ showControls }: { showControls: boolean }) {
  const members = useWatchPartyStore((s) => s.members);
  const reactions = useWatchPartyStore((s) => s.reactions);
  const chat = useWatchPartyStore((s) => s.chat);
  const floatingChat = useWatchPartyStore((s) => s.floatingChat);
  const code = useWatchPartyStore((s) => s.code);
  const react = useWatchPartyStore((s) => s.react);
  const sendChat = useWatchPartyStore((s) => s.sendChat);

  const [chatOpen, setChatOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (chatOpen && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chat, chatOpen]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    sendChat(text);
    setDraft("");
  };

  const online = members.filter((m) => m.online).length;

  return (
    <div className="pointer-events-none absolute inset-0 z-[45]">
      {/* Presence pill — top-right, fades with the controls. */}
      <div className={"absolute right-4 top-4 transition-opacity duration-300 md:right-8 " + (showControls ? "opacity-100" : "opacity-0")}>
        <div className="pointer-events-auto flex items-center gap-3 glass rounded-full px-3 py-1.5">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-white">
            <Users className="size-3.5 text-accent" /> Séance {code}
          </span>
          <div className="flex -space-x-2">
            {members.slice(0, 6).map((m) => (
              <div key={m.userId} className="relative" title={m.username + (m.isHost ? " (hôte)" : "") + (m.online ? "" : " — hors ligne")}>
                <div className={m.online ? "" : "opacity-40 grayscale"}>
                  <ProfileAvatar preset={m.avatar} name={m.username} size={26} />
                </div>
                {m.isHost && <Crown className="absolute -right-1 -top-1 size-3 fill-yellow-400 text-yellow-400" />}
              </div>
            ))}
            {members.length > 6 && <span className="flex size-[26px] items-center justify-center rounded-full bg-surface-hover text-[10px] font-semibold text-white">+{members.length - 6}</span>}
          </div>
          <span className="text-[10px] text-muted">{online} en ligne</span>
        </div>
      </div>

      {/* Floating reactions — always visible, rise from the bottom-centre. */}
      <div className="absolute inset-x-0 bottom-28 flex justify-center overflow-visible">
        <div className="relative h-0 w-64">
          {reactions.map((r) => (
            <div
              key={r.id}
              className="party-reaction absolute bottom-0 flex flex-col items-center"
              // Column derived purely from the stable r.id, never the array
              // index: reactions are spliced out as they expire, which would
              // reindex survivors and teleport a mid-animation bubble sideways.
              style={{ left: `${((r.id * 3) % 10) * 10}%` }}
            >
              <span className="text-4xl drop-shadow-lg">{r.emoji}</span>
              <span className="rounded-full bg-black/60 px-1.5 text-[9px] text-white">{r.by}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Floating chat bubbles — a short-lived stack over the bottom-left, so
          messages are seen without opening the drawer. Newest at the bottom. */}
      <div className="absolute bottom-36 left-4 flex max-w-[16rem] flex-col justify-end gap-1.5 md:left-8 md:max-w-xs">
        {floatingChat.slice(-4).map((m) => (
          <div key={m.id} className="party-chat-float flex items-start gap-2 glass rounded-field px-2.5 py-1.5">
            <div className="mt-0.5 shrink-0">
              <ProfileAvatar preset={m.avatar} name={m.by} size={20} />
            </div>
            <p className="min-w-0 break-words text-sm text-white">
              <span className="mr-1 font-semibold text-accent">{m.by}</span>
              {m.text}
            </p>
          </div>
        ))}
      </div>

      {/* Action bar — quick reactions + chat toggle, sitting above the controls
          and clear of the bottom-right « Passer l'intro » button. */}
      <div className={"absolute bottom-36 right-4 flex items-center gap-2 transition-opacity duration-300 md:right-8 " + (showControls || chatOpen ? "opacity-100" : "opacity-0 pointer-events-none")}>
        <div className="pointer-events-auto flex items-center gap-1 glass rounded-full px-2 py-1">
          {QUICK_REACTIONS.map((emoji) => (
            <button key={emoji} type="button" onClick={() => react(emoji)} className="rounded-full px-1 text-xl transition-transform hover:scale-125" aria-label={`Réagir ${emoji}`}>
              {emoji}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setChatOpen((v) => !v)}
          className="pointer-events-auto relative flex size-10 items-center justify-center glass rounded-full text-white hover:bg-white/15"
          aria-label="Ouvrir le tchat"
        >
          <MessageCircle className="size-5" />
          {chat.length > 0 && !chatOpen && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-accent" />}
        </button>
      </div>

      {/* Chat drawer — anchored above the action bar. */}
      {chatOpen && (
        <div className="pointer-events-auto absolute bottom-48 right-4 flex h-80 w-72 flex-col overflow-hidden glass rounded-panel shadow-pop animate-scale-in origin-bottom-right md:right-8">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
            <span className="text-sm font-semibold text-white">Tchat de la séance</span>
            <button type="button" onClick={() => setChatOpen(false)} aria-label="Fermer le tchat" className="text-muted hover:text-white">
              <X className="size-4" />
            </button>
          </div>
          <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-2">
            {chat.length === 0 ? (
              <p className="pt-8 text-center text-xs text-muted">Aucun message. Lancez la discussion !</p>
            ) : (
              chat.map((m) => (
                <div key={m.id} className="flex items-start gap-2">
                  <div className="mt-0.5 shrink-0">
                    <ProfileAvatar preset={m.avatar} name={m.by} size={22} />
                  </div>
                  <div className="min-w-0">
                    <span className="text-[11px] font-semibold text-accent">{m.by}</span>
                    <p className="break-words text-xs text-white">{m.text}</p>
                  </div>
                </div>
              ))
            )}
          </div>
          <form onSubmit={submit} className="flex items-center gap-1 border-t border-white/10 p-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Un message…"
              maxLength={300}
              className="min-w-0 flex-1 rounded-field bg-white/10 px-2 py-1.5 text-sm text-white outline-none placeholder:text-muted"
            />
            <button type="submit" disabled={!draft.trim()} aria-label="Envoyer" className="flex size-8 shrink-0 items-center justify-center rounded-field bg-accent text-white disabled:opacity-40">
              <Send className="size-4" />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
