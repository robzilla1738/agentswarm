"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { CodeChat } from "@/components/CodeChat";
import { TopBar } from "@/components/TopBar";
import { EmptyState, Spinner, StatusBadge } from "@/components/atoms";
import { api } from "@/lib/api";
import { fmtAgo } from "@/lib/format";
import { useConfig, useNow, useSessions } from "@/lib/hooks";

function CodeHome() {
  const params = useSearchParams();
  const id = params.get("id");
  if (id) {
    return (
      <div className="min-h-screen">
        <TopBar />
        <CodeChat id={id} />
      </div>
    );
  }
  return (
    <div className="min-h-screen">
      <TopBar hideLogo />
      <main className="max-w-3xl mx-auto px-5 sm:px-8 pb-12 pt-10">
        <NewChat />
        <SessionList />
      </main>
    </div>
  );
}

function NewChat() {
  const router = useRouter();
  const { config } = useConfig();
  const [message, setMessage] = useState("");
  const [target, setTarget] = useState<"managed" | "existing">("managed");
  const [dir, setDir] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noKey = config ? !config.apiKeySet && config.providers.find((p) => p.id === config.provider)?.keyRequired : false;
  const needsDir = target === "existing" && !dir.trim();

  const start = async () => {
    if (!message.trim() || submitting || noKey || needsDir) return;
    setSubmitting(true);
    setError(null);
    try {
      const { id } = await api.createSession({
        message: message.trim(),
        ...(target === "existing" ? { workspace: dir.trim() } : {}),
      });
      router.push(`/code?id=${id}`);
    } catch (e: any) {
      setError(e?.message || "could not start chat");
      setSubmitting(false);
    }
  };

  return (
    <section className="panel p-5 sm:p-6" style={{ animation: "var(--animate-rise)" }}>
      <div className="flex items-center gap-2 mb-1">
        <span className="glyph w-7 h-7 text-2xs">⌬</span>
        <h1 className="font-display text-lg">Code chat</h1>
      </div>
      <p className="text-sm text-ink-dim mb-4">
        Describe what to build. Every message iterates on the same codebase, remembers the conversation, and
        builds <span className="text-ink">exhaustive by default</span> — full feature parity, no dead buttons.
      </p>

      <textarea
        className="input resize-none leading-relaxed"
        rows={3}
        autoFocus
        placeholder='e.g. "Build a Notion clone with a sidebar, nested pages, a rich-text editor, slash commands, and a working New Page button — 1:1 parity."'
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") start();
        }}
      />

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="text-2xs text-ink-faint mr-1">Workspace</span>
        <button className="chip" data-active={target === "managed"} onClick={() => setTarget("managed")}
          style={target === "managed" ? { borderColor: "rgb(var(--ink) / 0.5)", color: "var(--color-ink)" } : undefined}
          title="A fresh project folder the app manages and persists across messages.">
          Fresh project
        </button>
        <button className="chip" data-active={target === "existing"} onClick={() => setTarget("existing")}
          style={target === "existing" ? { borderColor: "rgb(var(--ink) / 0.5)", color: "var(--color-ink)" } : undefined}
          title="Point the chat at a folder on your machine (e.g. an existing repo).">
          Existing folder
        </button>
      </div>

      {target === "existing" && (
        <FolderBrowser cwd={dir} onPick={setDir} />
      )}

      {error && <div className="text-sm text-ink mt-3">{error}</div>}
      {noKey && (
        <div className="text-sm text-ink-dim mt-3">
          No API key yet — <Link href="/settings" className="underline">add one in Settings</Link> to build.
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-2xs text-ink-faint">⌘↵ to start</span>
        <button className="btn btn-primary" disabled={!message.trim() || submitting || noKey || needsDir} onClick={start}>
          {submitting ? <Spinner size={12} /> : "Start building"}
        </button>
      </div>
    </section>
  );
}

function SessionList() {
  const { sessions, loading, error, refresh } = useSessions();
  const now = useNow(2000);

  if (loading && sessions.length === 0) {
    return (
      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
        {[0, 1].map((i) => <div key={i} className="panel h-24 skeleton opacity-50" />)}
      </div>
    );
  }
  if (error) {
    return <div className="panel p-4 mt-8 text-sm text-ink-dim">Can&apos;t reach the hub: {error}.</div>;
  }
  if (!sessions.length) {
    return (
      <div className="mt-10">
        <EmptyState glyph="⌬" title="No code chats yet" sub="Start one above — your first build kicks off immediately." />
      </div>
    );
  }

  return (
    <section className="mt-10">
      <h2 className="label mb-4">Your code chats · {sessions.length}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {sessions.map((s) => (
          <Link key={s.id} href={`/code?id=${s.id}`} className="panel p-4 hover:border-border transition-colors block">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink truncate flex-1">{s.title}</h3>
              {s.lastStatus && <StatusBadge status={s.live ? "running" : s.lastStatus} />}
            </div>
            <div className="mono text-2xs text-ink-faint truncate mt-1" title={s.workspace}>
              {s.workspaceKind === "managed" ? "managed" : "your folder"} · {s.workspace}
            </div>
            <div className="mono text-2xs text-ink-faint mt-2">
              {s.turns} message{s.turns === 1 ? "" : "s"} · {fmtAgo(s.updatedAt, now)}
              <button
                className="ml-2 text-ink-faint hover:text-ink"
                title="Delete chat"
                onClick={async (e) => {
                  e.preventDefault();
                  if (!confirm("Delete this code chat?")) return;
                  try { await api.deleteSession(s.id); refresh(); } catch { /* ignore */ }
                }}
              >
                ✕
              </button>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

/** Minimal folder picker — type a path or browse the filesystem (localhost hub). */
function FolderBrowser({ cwd, onPick }: { cwd: string; onPick: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<{ path: string; parent: string | null; dirs: { name: string; path: string }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const browse = (path?: string) =>
    api.listDirs(path).then((l) => { setListing(l); setErr(null); }).catch((e: any) => setErr(e?.message || "can't read directory"));

  useEffect(() => {
    if (open) browse(cwd.trim() || undefined);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <input
          className="input mono text-sm"
          placeholder="/path/to/your/project"
          value={cwd}
          onChange={(e) => onPick(e.target.value)}
        />
        <button className="btn btn-sm shrink-0" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Hide" : "Browse"}
        </button>
      </div>
      {open && (
        <div className="tile mt-2 overflow-hidden">
          {err && <div className="px-3 py-2.5 text-xs text-ink-dim">{err}</div>}
          {!err && !listing && <div className="px-3 py-2.5 text-xs text-ink-faint">Loading…</div>}
          {!err && listing && (
            <>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border-soft">
                <span className="mono text-xs text-ink-dim truncate flex-1" title={listing.path}>{listing.path}</span>
                <button className="btn btn-primary btn-sm shrink-0" onClick={() => { onPick(listing.path); setOpen(false); }}>
                  Use this folder
                </button>
              </div>
              <div className="max-h-52 overflow-y-auto py-1">
                {listing.parent && (
                  <button className="block w-full text-left px-3 py-1.5 text-sm mono text-ink-faint hover:text-ink" onClick={() => browse(listing.parent!)}>
                    ../
                  </button>
                )}
                {listing.dirs.map((d) => (
                  <button key={d.path} className="block w-full text-left px-3 py-1.5 text-sm mono text-ink-dim hover:text-ink truncate" onClick={() => browse(d.path)}>
                    {d.name}/
                  </button>
                ))}
                {listing.dirs.length === 0 && <div className="px-3 py-1.5 text-xs text-ink-faint">No subfolders</div>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function CodePage() {
  return (
    <Suspense fallback={<div className="min-h-screen grid place-items-center text-ink-faint"><Spinner /></div>}>
      <CodeHome />
    </Suspense>
  );
}
