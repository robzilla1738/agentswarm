import * as fs from "fs";
import { eventsFile, readNewEvents, TailState } from "./journal";
import { runDir } from "./config";
import { AgentView, RunState } from "./state";
import { SwarmEvent, Task } from "./types";
import { ansi, clip, fmtDur, fmtMoney, fmtTokens, oneLine } from "./util";
import { ModelPrice } from "./types";

const STATUS_STYLE: Record<string, (s: string) => string> = {
  pending: ansi.gray,
  running: ansi.cyan,
  verifying: ansi.magenta,
  done: ansi.green,
  failed: ansi.red,
  blocked: ansi.yellow,
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class TerminalRenderer {
  private state: RunState;
  private frame = 0;
  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private tty: boolean;
  private height = 40;
  private width = 100;

  constructor(pricing: Record<string, ModelPrice>) {
    this.state = new RunState(pricing);
    this.tty = Boolean(process.stdout.isTTY);
  }

  ingest(ev: SwarmEvent): void {
    this.state.apply(ev);
    if (!this.tty) this.streamLine(ev);
  }

  start(): void {
    if (!this.tty) {
      process.stdout.write("agentswarm: streaming (no TTY)\n");
      return;
    }
    this.active = true;
    process.stdout.write("\x1b[?25l"); // hide cursor
    this.timer = setInterval(() => this.render(), 250);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.tty && this.active) {
      this.render();
      process.stdout.write("\x1b[?25h"); // show cursor
    }
    this.active = false;
  }

  getState(): RunState {
    return this.state;
  }

  // ---------- non-tty streaming ----------

  private streamLine(ev: SwarmEvent): void {
    let line = "";
    switch (ev.type) {
      case "run.status":
        line = `[run] ${ev.status}${ev.reason ? ` — ${ev.reason}` : ""}`;
        break;
      case "task.created":
        line = `[task+] ${(ev.task as Task).id} ${(ev.task as Task).title}`;
        break;
      case "task.status":
        line = `[task] ${ev.taskId} → ${ev.status}${ev.reason ? ` (${oneLine(String(ev.reason), 80)})` : ""}`;
        break;
      case "agent.spawned":
        line = `[agent+] ${ev.agentId} (${ev.role}) ${oneLine(String(ev.purpose ?? ""), 60)}`;
        break;
      case "tool.call":
        line = `  ${ev.agentId} · ${ev.name}`;
        break;
      case "conductor.action":
        line = `[conductor] ${ev.kind}`;
        break;
      case "note.added":
        line = `[note] ${oneLine(String(ev.text), 100)}`;
        break;
      case "operator.note":
        line = `[operator] ${oneLine(String(ev.text), 100)}`;
        break;
      case "run.final":
        line = `[final] ${oneLine(String(ev.summary), 200)}`;
        break;
      case "log":
        if (ev.level !== "info") line = `[${ev.level}] ${ev.msg}`;
        break;
    }
    if (line) process.stdout.write(line + "\n");
  }

  // ---------- tty dashboard ----------

  private render(): void {
    if (!this.tty) return;
    this.frame++;
    this.height = process.stdout.rows || 40;
    this.width = Math.min(process.stdout.columns || 100, 120);
    const lines = this.compose();
    const clipped = lines.slice(0, this.height - 1);
    let out = "\x1b[H"; // cursor home
    out += clipped.map((l) => l + "\x1b[K").join("\n"); // each line clears to EOL
    out += "\x1b[J"; // clear below
    process.stdout.write(out);
  }

  private compose(): string[] {
    const s = this.state;
    const spin = SPINNER[this.frame % SPINNER.length];
    const L: string[] = [];
    const W = this.width;

    const live = ["planning", "running", "synthesizing"].includes(s.status);
    const statusIcon = live ? ansi.cyan(spin) : s.status === "done" ? ansi.green("●") : ansi.red("●");
    L.push(
      `${statusIcon} ${ansi.bold("agentswarm")} ${ansi.gray("·")} ${statusColor(s.status)} ${ansi.gray("·")} ${ansi.gray(s.meta?.id ?? "")}`
    );
    L.push(ansi.gray("  mission: ") + clip(oneLine(s.meta?.mission ?? "", W - 12), W - 12));

    // budget bar
    const cap = s.meta?.options.maxTokens ?? 1;
    const pct = Math.min(100, Math.round((s.totalUsage.promptTokens + s.totalUsage.completionTokens) / cap * 100));
    const barW = Math.max(10, Math.min(40, W - 50));
    const filled = Math.round((pct / 100) * barW);
    const bar = ansi.cyan("█".repeat(filled)) + ansi.gray("░".repeat(barW - filled));
    const spent = s.totalUsage.promptTokens + s.totalUsage.completionTokens;
    L.push(
      `  ${bar} ${pct}%  ${ansi.gray(fmtTokens(spent) + "/" + fmtTokens(cap) + " tok")}  ${ansi.green(fmtMoney(s.cost))}`
    );

    const tasks = s.taskList();
    const counts = {
      done: tasks.filter((t) => t.status === "done").length,
      running: tasks.filter((t) => t.status === "running" || t.status === "verifying").length,
      pending: tasks.filter((t) => t.status === "pending").length,
      failed: tasks.filter((t) => t.status === "failed").length,
      blocked: tasks.filter((t) => t.status === "blocked").length,
    };
    L.push(
      ansi.gray("  ") +
        `${ansi.green(counts.done + " done")}  ${ansi.cyan(counts.running + " running")}  ${ansi.gray(counts.pending + " pending")}  ${counts.failed ? ansi.red(counts.failed + " failed") : ansi.gray("0 failed")}  ${counts.blocked ? ansi.yellow(counts.blocked + " blocked") : ansi.gray("0 blocked")}`
    );
    L.push("");

    // active agents
    const agents = s.activeAgents();
    if (agents.length) {
      L.push(ansi.bold(`  Active agents (${agents.length})`));
      for (const a of agents.slice(0, 8)) {
        L.push(this.agentLine(a, spin, W));
      }
      if (agents.length > 8) L.push(ansi.gray(`    …and ${agents.length - 8} more`));
      L.push("");
    }

    // task table
    L.push(ansi.bold("  Tasks"));
    const visibleTasks = this.pickTasks(tasks, Math.max(6, this.height - L.length - 10));
    for (const t of visibleTasks) {
      L.push(this.taskLine(t, spin, W));
    }
    if (tasks.length > visibleTasks.length) {
      L.push(ansi.gray(`    …${tasks.length - visibleTasks.length} more tasks`));
    }

    // conductor latest
    const lastSay = s.conductorLog[s.conductorLog.length - 1];
    if (lastSay) {
      L.push("");
      L.push(ansi.bold("  Conductor"));
      for (const ln of wrap(oneLine(lastSay.text, 600), W - 6).slice(0, 3)) {
        L.push(ansi.gray("    ") + ansi.italic(ln));
      }
    }

    // notes
    if (s.notes.length) {
      L.push("");
      L.push(ansi.bold(`  Blackboard (${s.notes.length})`));
      for (const n of s.notes.slice(-3)) {
        L.push(ansi.gray("    • ") + clip(oneLine((n.key ? `[${n.key}] ` : "") + n.text, W - 8), W - 8));
      }
    }

    // operator hint
    if (live) {
      L.push("");
      L.push(ansi.gray("  Ctrl-C to detach (run keeps going) · ") + ansi.gray(`swarm note ${s.meta?.id} "…" to steer · swarm cancel ${s.meta?.id}`));
    } else if (s.finalSummary) {
      L.push("");
      L.push(ansi.bold(ansi.green("  ✓ Final summary")));
      for (const ln of wrap(s.finalSummary, W - 6).slice(0, 6)) L.push("    " + ln);
      if (s.finalReportPath) L.push(ansi.gray("    report: ") + s.finalReportPath);
    }

    return L;
  }

  private agentLine(a: AgentView, spin: string, W: number): string {
    const role = ansi.magenta(`${a.role}`);
    const head = `    ${ansi.cyan(spin)} ${ansi.gray(a.taskId)} ${role} ${ansi.gray("·")} `;
    const tool = a.lastTool ? ansi.yellow(a.lastTool) + " " : "";
    const txt = oneLine(a.lastText || a.lastThink || a.purpose, W - 40);
    return clip(head + tool + ansi.gray(txt), W + 40); // +40 accounts for ansi codes roughly
  }

  private taskLine(t: Task, spin: string, W: number): string {
    const style = STATUS_STYLE[t.status] ?? ansi.white;
    const icon =
      t.status === "running" || t.status === "verifying"
        ? ansi.cyan(spin)
        : t.status === "done"
          ? ansi.green("✓")
          : t.status === "failed"
            ? ansi.red("✗")
            : t.status === "blocked"
              ? ansi.yellow("⊘")
              : ansi.gray("○");
    const id = style(t.id.padEnd(4));
    const role = ansi.gray(`(${t.role})`);
    const deps = t.deps.length ? ansi.gray(` ⇠${t.deps.join(",")}`) : "";
    const v = t.verify ? ansi.magenta(" ⊛") : "";
    const dur = t.startedAt ? ansi.gray(" " + fmtDur((t.endedAt ?? Date.now()) - t.startedAt)) : "";
    const title = clip(t.title, Math.max(20, W - 38));
    return `    ${icon} ${id} ${title} ${role}${deps}${v}${dur}`;
  }

  private pickTasks(tasks: Task[], budget: number): Task[] {
    if (tasks.length <= budget) return tasks;
    // Prioritize active + recently settled.
    const active = tasks.filter((t) => ["running", "verifying", "pending"].includes(t.status));
    const settled = tasks.filter((t) => ["done", "failed", "blocked"].includes(t.status));
    const keepSettled = Math.max(0, budget - active.length);
    return [...settled.slice(-keepSettled), ...active].slice(-budget);
  }
}

function statusColor(s: string): string {
  switch (s) {
    case "done":
      return ansi.green(ansi.bold("done"));
    case "failed":
      return ansi.red(ansi.bold("failed"));
    case "cancelled":
      return ansi.yellow("cancelled");
    case "synthesizing":
      return ansi.magenta("synthesizing");
    case "running":
      return ansi.cyan("running");
    case "planning":
      return ansi.cyan("planning");
    default:
      return s;
  }
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Tail a run's journal into a renderer until it goes terminal (for `watch`). */
export async function watchRun(id: string, pricing: Record<string, ModelPrice>): Promise<void> {
  const renderer = new TerminalRenderer(pricing);
  const file = eventsFile(runDir(id));
  const tail: TailState = { offset: 0, carry: "" };
  renderer.start();
  return new Promise((resolve) => {
    const tick = () => {
      let evs: SwarmEvent[] = [];
      try {
        evs = readNewEvents(file, tail);
      } catch {
        /* file not ready */
      }
      for (const ev of evs) renderer.ingest(ev);
      const st = renderer.getState().status;
      if (["done", "failed", "cancelled"].includes(st)) {
        setTimeout(() => {
          // one last drain
          try {
            for (const ev of readNewEvents(file, tail)) renderer.ingest(ev);
          } catch { /* ignore */ }
          renderer.stop();
          resolve();
        }, 500);
        return;
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}
