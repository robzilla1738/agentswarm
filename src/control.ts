import * as fs from "fs";
import * as path from "path";
import { safeJson } from "./util";

/**
 * Operator → executor control channel. The hub (or CLI) appends JSON lines;
 * the running executor polls for them. Separate from the journal so a
 * read-only tailer never confuses control input with run output.
 */
export interface ControlMsg {
  t: number;
  kind: "note" | "cancel" | "approve";
  text?: string;
}

export function controlFile(runDirPath: string): string {
  return path.join(runDirPath, "control.jsonl");
}

export function appendControl(runDirPath: string, msg: Omit<ControlMsg, "t">): void {
  const line = JSON.stringify({ t: Date.now(), ...msg }) + "\n";
  fs.appendFileSync(controlFile(runDirPath), line, "utf8");
}

export class ControlReader {
  private file: string;
  private offset = 0;

  constructor(runDirPath: string) {
    this.file = controlFile(runDirPath);
    try {
      this.offset = fs.statSync(this.file).size;
    } catch {
      this.offset = 0;
    }
  }

  poll(): ControlMsg[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return [];
    }
    if (stat.size <= this.offset) {
      if (stat.size < this.offset) this.offset = 0;
      return [];
    }
    const fd = fs.openSync(this.file, "r");
    try {
      const len = stat.size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      this.offset = stat.size;
      const out: ControlMsg[] = [];
      for (const line of buf.toString("utf8").split("\n")) {
        const s = line.trim();
        if (!s) continue;
        const msg = safeJson<ControlMsg>(s);
        if (msg && msg.kind) out.push(msg);
      }
      return out;
    } finally {
      fs.closeSync(fd);
    }
  }
}
