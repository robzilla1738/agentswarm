import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { home } from "./config";
import { CodeCommands } from "./types";
import { ensureDir } from "./util";

/**
 * Cross-run repo memory (the forecast-ledger analog for code mode). After a
 * green run the engine persists what it learned the hard way about a repo —
 * which build/test commands actually worked, conventions, flaky tests — keyed by
 * repo identity + a manifest hash. The next run loads these to bootstrap recon,
 * so run N+1 starts where run N ended instead of re-deriving everything.
 *
 * Stored at ~/.agentswarm/repo-facts.jsonl, append-only, malformed-line-tolerant.
 */
export interface RepoFactsRecord {
  /** Repo identity — git remote URL when available, else a hash of the absolute path. */
  key: string;
  /** Signature of the build setup; facts are discarded when it no longer matches (the repo changed how it builds). */
  manifestHash: string;
  /** When this record was written (ms). */
  at: number;
  /** Commands confirmed to run green this run. */
  commands: CodeCommands;
  /** Conventions observed (from recon + workers). */
  conventions: string[];
  /** Tests seen to flake / time out (advisory for the next run). */
  flakyTests?: string[];
}

export function repoFactsPath(): string {
  return path.join(home(), "repo-facts.jsonl");
}

/** Stable identity for a repo: prefer the git remote URL, else a short hash of the absolute path. */
export function repoKey(remoteUrl: string | null | undefined, absPath: string): string {
  const remote = (remoteUrl ?? "").trim();
  if (remote) return `remote:${remote.replace(/\.git$/, "").replace(/^git@([^:]+):/, "https://$1/")}`;
  return `path:${crypto.createHash("sha1").update(absPath).digest("hex").slice(0, 16)}`;
}

/** A cheap signature of how the repo builds — changes when manifests / detected commands change. */
export function manifestHash(parts: { commands: CodeCommands; manifestFiles: string[]; packageManager: string | null; primaryLanguage: string | null }): string {
  return crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

export function appendRepoFacts(rec: RepoFactsRecord): void {
  try {
    ensureDir(home());
    fs.appendFileSync(repoFactsPath(), JSON.stringify(rec) + "\n", "utf8");
  } catch {
    /* best-effort — repo memory never blocks a run */
  }
}

/**
 * Latest facts for a repo key. Prefers a record whose manifestHash matches the
 * current setup (fresh); returns null if none match (the build changed → the old
 * facts are stale and must not mislead recon). Malformed lines are skipped.
 */
export function loadRepoFacts(key: string, currentManifestHash: string): RepoFactsRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(repoFactsPath(), "utf8");
  } catch {
    return null;
  }
  let best: RepoFactsRecord | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: RepoFactsRecord;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.key !== key || rec.manifestHash !== currentManifestHash) continue;
    if (!best || (rec.at ?? 0) > (best.at ?? 0)) best = rec;
  }
  return best;
}

/**
 * Merge confirmed facts into a freshly-detected command set: detection wins when
 * it found something, confirmed facts fill the gaps (e.g. a test command recon
 * missed but a prior run established). Pure; returns a new object.
 */
export function mergeConfirmedCommands(detected: CodeCommands, confirmed: CodeCommands): { commands: CodeCommands; filled: (keyof CodeCommands)[] } {
  const out: CodeCommands = { ...detected };
  const filled: (keyof CodeCommands)[] = [];
  for (const k of ["install", "build", "typecheck", "test", "lint"] as (keyof CodeCommands)[]) {
    if (!out[k] && confirmed[k]) {
      out[k] = confirmed[k];
      filled.push(k);
    }
  }
  return { commands: out, filled };
}
