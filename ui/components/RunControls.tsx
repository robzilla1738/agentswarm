"use client";

import { useState } from "react";
import { api } from "@/lib/api";

export function NoteComposer({ id, onSent }: { id: string; onSent?: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.note(id, text.trim());
      setText("");
      setFlash(true);
      setTimeout(() => setFlash(false), 1400);
      onSent?.();
    } catch (e: any) {
      // Keep the typed text so the operator can retry — this is the one live
      // steering control, so a swallowed failure is unacceptable.
      setError(e?.message || "couldn't reach the conductor — retry");
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          className="input"
          placeholder="Steer the conductor — type guidance and press ↵"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          style={{ fontSize: 13, padding: "9px 13px" }}
        />
        <button className="btn" disabled={!text.trim() || sending} onClick={send}>
          {flash ? "Sent ✓" : "Send"}
        </button>
      </div>
      {error && (
        <div
          className="mt-2 text-2xs text-ink px-2.5 py-1.5 rounded-[8px]"
          style={{ background: "rgb(var(--hi) / 0.06)", border: "1px solid rgb(var(--hi) / 0.2)" }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

export function CancelButton({ id, live }: { id: string; live: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [failed, setFailed] = useState(false);

  // The button disappears on its own once the run actually leaves "live".
  if (!live) return null;

  if (stopping) {
    return (
      <button className="btn" disabled>
        stopping…
      </button>
    );
  }

  return confirming ? (
    <div className="flex items-center gap-1.5">
      <button
        className="btn btn-danger"
        onClick={async () => {
          setStopping(true);
          setConfirming(false);
          setFailed(false);
          try {
            await api.cancel(id);
          } catch {
            // Surface the failure instead of silently reverting — mirrors ResumeButton.
            setStopping(false);
            setFailed(true);
          }
        }}
      >
        Confirm stop
      </button>
      <button className="btn" onClick={() => setConfirming(false)}>
        Keep
      </button>
    </div>
  ) : (
    <button className="btn btn-danger" onClick={() => setConfirming(true)}>
      {failed ? "Stop failed — retry" : "Stop"}
    </button>
  );
}
