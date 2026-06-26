import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * A tiny, zero-hard-dependency headless-Chrome driver over the Chrome DevTools
 * Protocol (CDP). The engine spawns its OWN isolated headless instance (its own
 * --user-data-dir on a private port) so it never touches the operator's running
 * Chrome. Used by the visual/functional parity pass to render the built web app,
 * screenshot it, read its DOM, and drive its controls.
 *
 * Modeled on the project's browser-harness helpers (Page.navigate, readyState
 * poll, Page.captureScreenshot, Runtime.evaluate, Input.dispatchMouseEvent), but
 * standalone — no shared daemon, no socket, no external package. Everything is
 * best-effort and bounded: a missing Chrome, a missing WebSocket impl, or any
 * failure degrades to "unavailable", and the caller skips visual checks.
 */

const CHROME_CANDIDATES: string[] =
  process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ]
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
        "/usr/bin/microsoft-edge",
    ];

/** Resolve a usable Chrome/Chromium binary, or null. Honors CHROME_PATH / PUPPETEER_EXECUTABLE_PATH. */
export function findChrome(): string | null {
  const envPaths = [process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH].filter(Boolean) as string[];
  for (const p of [...envPaths, ...CHROME_CANDIDATES]) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      /* keep probing */
    }
  }
  return null;
}

function wsImpl(): typeof WebSocket | null {
  const g = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (g) return g;
  try {
    // Node < 22 fallback if the optional package happens to be installed.
    return require("ws") as typeof WebSocket;
  } catch {
    return null;
  }
}

/** True when a real headless render is possible here (a Chrome binary + a WebSocket impl). */
export function browserAvailable(): boolean {
  return findChrome() !== null && wsImpl() !== null;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

export interface DeadControl {
  label: string;
  reason: "no-effect" | "threw";
  detail?: string;
}

export class HeadlessBrowser {
  private proc?: ChildProcess;
  private ws?: WebSocket;
  private userDataDir?: string;
  private sessionId?: string;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private consoleErrs: string[] = [];
  private exceptionErrs: string[] = [];
  private closed = false;

  /** Spawn an isolated headless Chrome, attach to a fresh page, enable the domains we use. */
  async start(opts: { width?: number; height?: number; timeoutMs?: number } = {}): Promise<void> {
    const bin = findChrome();
    const WS = wsImpl();
    if (!bin || !WS) throw new Error("no headless browser available");
    const width = opts.width ?? 1280;
    const height = opts.height ?? 900;
    const timeoutMs = opts.timeoutMs ?? 20_000;
    this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-chrome-"));
    this.proc = spawn(
      bin,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--mute-audio",
        "--hide-scrollbars",
        `--window-size=${width},${height}`,
        "--remote-debugging-port=0",
        `--user-data-dir=${this.userDataDir}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore"], detached: false }
    );
    this.proc.on("exit", () => {
      if (!this.closed) this.failAll(new Error("chrome exited"));
    });

    // Chrome writes the chosen port + browser ws path to DevToolsActivePort.
    const portFile = path.join(this.userDataDir, "DevToolsActivePort");
    const deadline = Date.now() + timeoutMs;
    let endpoint = "";
    while (Date.now() < deadline) {
      try {
        const raw = fs.readFileSync(portFile, "utf8").trim().split("\n");
        if (raw.length >= 2 && raw[0]) {
          endpoint = `ws://127.0.0.1:${raw[0].trim()}${raw[1].trim()}`;
          break;
        }
      } catch {
        /* not ready yet */
      }
      await sleep(120);
    }
    if (!endpoint) throw new Error("chrome did not expose a debugging port in time");

    await this.connect(WS, endpoint, deadline);
    // Open a real page target and attach (flatten → commands carry sessionId).
    const created = (await this.browserSend("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const attached = (await this.browserSend("Target.attachToTarget", { targetId: created.targetId, flatten: true })) as { sessionId: string };
    this.sessionId = attached.sessionId;
    await this.send("Page.enable", {});
    await this.send("Runtime.enable", {});
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }).catch(() => {});
  }

  private connect(WS: typeof WebSocket, endpoint: string, deadline: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WS(endpoint);
      this.ws = ws;
      const to = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("CDP websocket connect timeout"));
        }
      }, Math.max(1000, deadline - Date.now())).unref?.();
      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        if (to) clearTimeout(to as unknown as NodeJS.Timeout);
        resolve();
      });
      ws.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        reject(new Error("CDP websocket error"));
      });
      ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(String(ev.data)));
      ws.addEventListener("close", () => {
        if (!this.closed) this.failAll(new Error("CDP websocket closed"));
      });
    });
  }

  private onMessage(data: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
      else p.resolve(msg.result);
      return;
    }
    // Events: console.error noise vs. real uncaught exceptions are tracked
    // SEPARATELY — a dev server emits async console.error constantly (framework
    // warnings, failed analytics/polling), so only a genuine thrown exception is
    // a reliable "this control is broken" signal.
    if (msg.method === "Runtime.consoleAPICalled") {
      const p = msg.params as { type?: string; args?: { value?: unknown }[] };
      if (p?.type === "error") this.consoleErrs.push((p.args || []).map((a) => String(a?.value ?? "")).join(" ").slice(0, 300));
    } else if (msg.method === "Runtime.exceptionThrown") {
      const p = msg.params as { exceptionDetails?: { exception?: { description?: string }; text?: string } };
      this.exceptionErrs.push((p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || "exception").slice(0, 300));
    }
  }

  private raw(method: string, params: unknown, sessionId?: string, timeoutMs = 30_000): Promise<unknown> {
    if (!this.ws || this.closed) return Promise.reject(new Error("browser not connected"));
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params: params ?? {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      if (typeof (to as unknown as { unref?: () => void }).unref === "function") (to as unknown as { unref: () => void }).unref();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(to);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(to);
          reject(e);
        },
      });
      try {
        this.ws!.send(JSON.stringify(payload));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(to);
        reject(e as Error);
      }
    });
  }

  private browserSend(method: string, params: unknown): Promise<unknown> {
    return this.raw(method, params);
  }
  private send(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    return this.raw(method, params, this.sessionId, timeoutMs);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** Navigate and wait for the page to finish loading. */
  async navigate(url: string, timeoutMs = 30_000): Promise<void> {
    this.consoleErrs = [];
    this.exceptionErrs = [];
    await this.send("Page.navigate", { url }, timeoutMs);
    await this.waitForLoad(timeoutMs);
  }

  /** Poll document.readyState until "complete" (or timeout). */
  async waitForLoad(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.evaluate<string>("document.readyState").catch(() => "");
      if (state === "complete") {
        await sleep(250); // let first paint / hydration settle
        return;
      }
      await sleep(150);
    }
  }

  /** Evaluate JS in the page and return the value (returnByValue + awaitPromise). */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const res = (await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
      result?: { value?: T };
      exceptionDetails?: { exception?: { description?: string } };
    };
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || "evaluate threw");
    return res.result?.value as T;
  }

  /** Full-viewport PNG screenshot as a Buffer. */
  async screenshot(): Promise<Buffer> {
    const res = (await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })) as { data: string };
    return Buffer.from(res.data, "base64");
  }

  /** Screenshot encoded as a data: URL for a vision model. */
  async screenshotDataUrl(): Promise<string> {
    const buf = await this.screenshot();
    return `data:image/png;base64,${buf.toString("base64")}`;
  }

  /** Click at viewport coordinates (paired press/release). */
  async click(x: number, y: number): Promise<void> {
    const base = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  }

  /** `console.error` calls collected since the last navigate (noisy — advisory only). */
  consoleErrors(): string[] {
    return [...this.consoleErrs];
  }

  /** Real uncaught exceptions collected since the last navigate (the reliable "broken" signal). */
  uncaughtExceptions(): string[] {
    return [...this.exceptionErrs];
  }

  /** Tear down: close the socket, kill Chrome, remove the temp profile. Never throws. */
  async destroy(): Promise<void> {
    this.closed = true;
    this.failAll(new Error("browser destroyed"));
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    try {
      if (this.proc && this.proc.pid && this.proc.exitCode === null) this.proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    try {
      if (this.userDataDir) fs.rmSync(this.userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
