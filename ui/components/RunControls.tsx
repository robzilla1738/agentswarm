"use client";

import { useState } from "react";
import { api } from "@/lib/api";

export function NoteComposer({ id, onSent }: { id: string; onSent?: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState(false);

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await api.note(id, text.trim());
      setText("");
      setFlash(true);
      setTimeout(() => setFlash(false), 1400);
      onSent?.();
    } finally {
      setSending(false);
    }
  };

  return (
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
  );
}

export function CancelButton({ id, live }: { id: string; live: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);

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
          try {
            await api.cancel(id);
          } catch {
            setStopping(false);
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
      Stop
    </button>
  );
}
