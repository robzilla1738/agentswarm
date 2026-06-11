import * as fs from "fs";
import * as path from "path";
import { SwarmEvent } from "./types";

/**
 * Append-only event journal. events.jsonl is the single source of truth for a
 * run: the executor writes it, the terminal renderer and the hub (web UI) read
 * and tail it. Tolerant of a torn final line after a crash.
 */
/** What the executor needs from a journal — satisfied by Journal and TeamJournal. */
export interface JournalLike {
  append(type: string, payload?: Record<string, unknown>): SwarmEvent;
  flush(): Promise<void>;
  readonly degraded: boolean;
}

/**
 * A child swarm's view of its parent's journal: same file, same sequence,
 * every event stamped with the owning team's task id so the reducer can
 * partition team activity away from the root run.
 */
export class TeamJournal implements JournalLike {
  constructor(
    private inner: JournalLike,
    private teamId: string
  ) {}

  append(type: string, payload: Record<string, unknown> = {}): SwarmEvent {
    return this.inner.append(type, { teamId: this.teamId, ...payload });
  }

  flush(): Promise<void> {
    return this.inner.flush();
  }

  get degraded(): boolean {
    return this.inner.degraded;
  }
}

export class Journal {
  private file: string;
  private seq: number;
  private chain: Promise<void> = Promise.resolve();
  private buf = "";
  private failures = 0;
  /** Set after repeated append failures: the source of truth is no longer being persisted. */
  degraded = false;
  onEvent?: (ev: SwarmEvent) => void;

  constructor(runDirPath: string, startSeq?: number) {
    this.file = path.join(runDirPath, "events.jsonl");
    this.seq = startSeq ?? lastSeq(runDirPath) + 1;
  }

  append(type: string, payload: Record<string, unknown> = {}): SwarmEvent {
    const ev: SwarmEvent = { seq: this.seq++, t: Date.now(), type, ...payload };
    this.buf += JSON.stringify(ev) + "\n";
    this.chain = this.chain.then(() => this.drain());
    try {
      this.onEvent?.(ev);
    } catch {
      /* renderer errors must not kill the run */
    }
    return ev;
  }

  private async drain(): Promise<void> {
    if (!this.buf) return;
    const chunk = this.buf;
    this.buf = "";
    try {
      await fs.promises.appendFile(this.file, chunk, "utf8");
      this.failures = 0;
    } catch (e) {
      // Keep the unwritten events buffered so the next append/flush retries
      // them in order; after repeated failures, stop pretending it's fine.
      this.buf = chunk + this.buf;
      this.failures++;
      if (this.failures >= 5 && !this.degraded) {
        this.degraded = true;
        process.stderr.write(`agentswarm: journal writes are failing (${String(e)}); run state is no longer durable\n`);
      }
    }
  }

  flush(): Promise<void> {
    return this.chain.then(() => this.drain());
  }

  /** Last-gasp synchronous flush for signal handlers and exit paths. */
  flushSync(): void {
    if (!this.buf) return;
    try {
      fs.appendFileSync(this.file, this.buf, "utf8");
      this.buf = "";
    } catch {
      /* nothing left to do */
    }
  }
}

export function eventsFile(runDirPath: string): string {
  return path.join(runDirPath, "events.jsonl");
}

export function readEvents(runDirPath: string): SwarmEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(eventsFile(runDirPath), "utf8");
  } catch {
    return [];
  }
  return parseLines(raw).events;
}

export function lastSeq(runDirPath: string): number {
  const evs = readEvents(runDirPath);
  return evs.length ? evs[evs.length - 1].seq : 0;
}

export interface TailState {
  offset: number;
  carry: string;
}

/** Incremental read for tailing; handles partially written lines. */
export function readNewEvents(
  file: string,
  state: TailState
): SwarmEvent[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  if (stat.size < state.offset) {
    // Truncated/rewritten (should not happen) — start over.
    state.offset = 0;
    state.carry = "";
  }
  if (stat.size === state.offset) return [];
  const fd = fs.openSync(file, "r");
  try {
    const len = stat.size - state.offset;
    const buf = Buffer.alloc(Math.min(len, 8 * 1024 * 1024));
    let read = 0;
    const out: SwarmEvent[] = [];
    while (read < len) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, len - read), state.offset + read);
      if (n <= 0) break;
      read += n;
      const text = state.carry + buf.toString("utf8", 0, n);
      const parsed = parseLines(text, true);
      state.carry = parsed.carry;
      out.push(...parsed.events);
    }
    state.offset += read;
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(
  text: string,
  keepCarry = false
): { events: SwarmEvent[]; carry: string } {
  const events: SwarmEvent[] = [];
  const lines = text.split("\n");
  const carry = keepCarry ? lines.pop() ?? "" : "";
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try {
      const ev = JSON.parse(s) as SwarmEvent;
      if (ev && typeof ev.type === "string") events.push(ev);
    } catch {
      /* torn line — skip */
    }
  }
  return { events, carry };
}
