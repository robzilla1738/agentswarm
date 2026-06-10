import * as fs from "fs";
import * as path from "path";
import { SwarmEvent } from "./types";

/**
 * Append-only event journal. events.jsonl is the single source of truth for a
 * run: the executor writes it, the terminal renderer and the hub (web UI) read
 * and tail it. Tolerant of a torn final line after a crash.
 */
export class Journal {
  private file: string;
  private seq: number;
  private chain: Promise<void> = Promise.resolve();
  onEvent?: (ev: SwarmEvent) => void;

  constructor(runDirPath: string, startSeq?: number) {
    this.file = path.join(runDirPath, "events.jsonl");
    this.seq = startSeq ?? lastSeq(runDirPath) + 1;
  }

  append(type: string, payload: Record<string, unknown> = {}): SwarmEvent {
    const ev: SwarmEvent = { seq: this.seq++, t: Date.now(), type, ...payload };
    const line = JSON.stringify(ev) + "\n";
    this.chain = this.chain
      .then(() => fs.promises.appendFile(this.file, line, "utf8"))
      .catch(() => {
        /* never break the run on journal IO; next append retries the chain */
      });
    try {
      this.onEvent?.(ev);
    } catch {
      /* renderer errors must not kill the run */
    }
    return ev;
  }

  flush(): Promise<void> {
    return this.chain;
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
