"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, PublicConfig } from "@/lib/api";
import { fmtTokens } from "@/lib/format";
import { Spinner } from "./atoms";

const EXAMPLES = [
  ["Research", "Research the top 5 open-source vector databases in 2026 and produce a comparison table with a recommendation for a RAG app at 10M vectors."],
  ["Build", "Build a small CLI tool in Python that converts CSV to a formatted Markdown table, with tests. Save it as an artifact."],
  ["Audit", "Audit this codebase for security issues and dependency risks, then write a prioritized remediation plan."],
  ["Plan", "Plan and draft a 6-email onboarding sequence for a developer-tools SaaS, with subject lines and send timing."],
] as const;

const FORECAST_EXAMPLES = [
  ["Rates", "Will the Federal Reserve cut its target rate at the next FOMC meeting?"],
  ["Elections", "Will the incumbent party win the next national election in Germany?"],
  ["Tech", "Will a major AI lab release a publicly available model that scores above 95% on SWE-bench Verified before year end?"],
  ["Markets", "What will the S&P 500 close at on the last trading day of this quarter?"],
] as const;

const clamp = (v: number, lo: number, hi: number, fallback: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;

interface Knobs {
  workers: number;
  tasks: number;
  steps: number;
  budgetM: number;
  verification: string;
}

/** Quick = cheap sanity pass. Deep = long-horizon research with strict QA. */
const QUICK: Knobs = { workers: 4, tasks: 16, steps: 20, budgetM: 4, verification: "off" };
const DEEP: Knobs = { workers: 20, tasks: 300, steps: 80, budgetM: 120, verification: "strict" };

export function MissionComposer({ config }: { config: PublicConfig | null }) {
  const router = useRouter();
  const [mission, setMission] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [workers, setWorkers] = useState(6);
  const [tasks, setTasks] = useState(48);
  const [steps, setSteps] = useState(30);
  const [budgetM, setBudgetM] = useState(12);
  const [verification, setVerification] = useState("normal");
  const [model, setModel] = useState("deepseek-v4-flash");
  const [effort, setEffort] = useState("high");
  const [workspace, setWorkspace] = useState<"sandbox" | "dir">("sandbox");
  const [cwd, setCwd] = useState("");
  const [mode, setMode] = useState<"research" | "forecast">("research");
  const [resolutionDate, setResolutionDate] = useState("");
  const [panelSize, setPanelSize] = useState(5);

  // Config arrives async; adopt its defaults unless the operator already
  // touched the options (useState initializers only run on first render).
  const touched = useRef(false);
  useEffect(() => {
    if (!config || touched.current) return;
    setWorkers(config.maxWorkers);
    setTasks(config.maxTasks);
    setSteps(config.maxStepsPerTask);
    setBudgetM(config.maxTokensPerRun / 1e6);
    setVerification(config.verification);
    setModel(config.model);
    setEffort(config.reasoningEffort);
    if (config.forecastPanelSize) setPanelSize(config.forecastPanelSize);
  }, [config]);

  const noKey = config ? !config.apiKeySet : false;
  const needsCwd = workspace === "dir" && !cwd.trim();
  const providerLabel = config?.providers?.find((p) => p.id === config.provider)?.label;

  // "Standard" is whatever the operator saved as defaults in Settings.
  const standard: Knobs = {
    workers: config?.maxWorkers ?? 6,
    tasks: config?.maxTasks ?? 48,
    steps: config?.maxStepsPerTask ?? 30,
    budgetM: (config?.maxTokensPerRun ?? 12_000_000) / 1e6,
    verification: config?.verification ?? "normal",
  };
  const current: Knobs = { workers, tasks, steps, budgetM, verification };
  const matches = (k: Knobs) =>
    k.workers === current.workers &&
    k.tasks === current.tasks &&
    k.steps === current.steps &&
    k.budgetM === current.budgetM &&
    k.verification === current.verification;
  const preset = matches(QUICK) ? "quick" : matches(DEEP) ? "deep" : matches(standard) ? "standard" : "custom";

  const applyPreset = (k: Knobs) => {
    touched.current = true;
    setWorkers(k.workers);
    setTasks(k.tasks);
    setSteps(k.steps);
    setBudgetM(k.budgetM);
    setVerification(k.verification);
  };

  // Rough worst-case spend at the selected model's list rates (80% input miss,
  // 20% output). Only a ceiling hint — caching usually lands far below it.
  const price = config?.pricing?.[model];
  const capEst = price && Number.isFinite(budgetM) ? budgetM * (price.inMiss * 0.8 + price.out * 0.2) : null;

  const launch = async () => {
    if (!mission.trim() || submitting || noKey || needsCwd) return;
    setSubmitting(true);
    setError(null);
    try {
      const { id } = await api.createRun({
        mission: mission.trim(),
        sandbox: workspace === "sandbox",
        ...(workspace === "dir" ? { cwd: cwd.trim() } : {}),
        options: {
          maxWorkers: clamp(workers, 1, 256, 6),
          maxTasks: clamp(tasks, 1, 1000, 48),
          maxStepsPerTask: clamp(steps, 3, 200, 30),
          maxTokens: clamp(budgetM * 1e6, 50_000, 2_000_000_000, 12_000_000),
          verification,
          model,
          reasoningEffort: effort,
          mode,
          ...(mode === "forecast" && resolutionDate ? { resolutionDate } : {}),
          ...(mode === "forecast" ? { panelSize: clamp(panelSize, 3, 11, 5) } : {}),
        },
      });
      router.push(`/run?id=${id}`);
    } catch (e: any) {
      setError(e?.message || "failed to launch");
      setSubmitting(false);
    }
  };

  const models = config?.knownModels ?? [];
  const markTouched = () => {
    touched.current = true;
  };

  return (
    <section className="panel p-5 sm:p-6" style={{ animation: "var(--animate-rise)" }}>
      <div className="flex items-center gap-1.5 mb-3">
        <PresetChip active={mode === "research"} onClick={() => setMode("research")} title="Decompose a mission into parallel research/build tasks">
          Research
        </PresetChip>
        <PresetChip
          active={mode === "forecast"}
          onClick={() => setMode("forecast")}
          title="Forecast an event: research waves feed an independent forecaster panel, mechanically aggregated into a calibrated probability"
        >
          Forecast
        </PresetChip>
      </div>

      <textarea
        className="input resize-none text-[15px] leading-relaxed"
        rows={3}
        autoFocus
        placeholder={
          mode === "forecast"
            ? 'Ask about the future — "Will X happen by 2026-12-31?" or "What will Y be in Q3?" — and get a calibrated probability from an independent forecaster panel.'
            : "Describe a mission — the swarm decomposes it into parallel tasks and runs them autonomously."
        }
        value={mission}
        onChange={(e) => setMission(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") launch();
        }}
      />

      {mode === "forecast" && (
        <div className="grid grid-cols-2 gap-3 mt-3">
          <Field label="Resolution date" hint="when the answer is knowable">
            <input
              type="date"
              className="input"
              value={resolutionDate}
              onChange={(e) => setResolutionDate(e.target.value)}
            />
          </Field>
          <Field label="Forecaster panel" hint="independent panelists">
            <input
              type="number"
              className="input"
              min={3}
              max={11}
              value={panelSize}
              onChange={(e) => setPanelSize(+e.target.value)}
            />
          </Field>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 mt-3">
        <span className="text-2xs text-ink-faint mr-1">Try</span>
        {(mode === "forecast" ? FORECAST_EXAMPLES : EXAMPLES).map(([tag, ex]) => (
          <button key={tag} onClick={() => setMission(ex)} title={ex} className="chip">
            {tag}
          </button>
        ))}
        {workspace === "sandbox" && (
          <button className="chip" title="Run the swarm inside an existing project or folder" onClick={() => setWorkspace("dir")}>
            ＋ Folder
          </button>
        )}
        <button
          className="btn btn-ghost btn-sm ml-auto"
          aria-expanded={advanced}
          style={{ color: advanced ? "var(--color-ink)" : undefined }}
          onClick={() => setAdvanced((v) => !v)}
        >
          {preset === "custom" ? "Options · custom" : `Options · ${preset}`}
          <span className="text-[9px]" style={{ transform: advanced ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>▼</span>
        </button>
      </div>

      {workspace === "dir" && (
        <FolderBrowser
          cwd={cwd}
          onPick={setCwd}
          onClose={() => { setWorkspace("sandbox"); setCwd(""); }}
        />
      )}

      <div className="collapse-v" data-open={advanced}>
        <div inert={!advanced}>
        <div className="mt-4 pt-4 space-y-4 border-t border-border-soft">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-2xs text-ink-faint mr-1">Size</span>
            <PresetChip active={preset === "quick"} onClick={() => applyPreset(QUICK)} title="4 agents · 16 tasks · small budget · no verification">
              Quick
            </PresetChip>
            <PresetChip active={preset === "standard"} onClick={() => applyPreset(standard)} title="Your saved defaults from Settings">
              Standard
            </PresetChip>
            <PresetChip active={preset === "deep"} onClick={() => applyPreset(DEEP)} title="20 agents · 300 tasks · 120M budget · strict verification — hundreds of sources, long-horizon research">
              Deep research
            </PresetChip>
            {preset === "custom" && <span className="chip text-ink">custom</span>}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" onInput={markTouched}>
            <Field label="Agents in parallel" hint="working at once">
              <input type="number" className="input" min={1} max={256} value={workers} onChange={(e) => setWorkers(+e.target.value)} />
            </Field>
            <Field label="Task limit" hint="whole run">
              <input type="number" className="input" min={1} max={1000} value={tasks} onChange={(e) => setTasks(+e.target.value)} />
            </Field>
            <Field label="Steps per task" hint="tool calls per agent">
              <input type="number" className="input" min={3} max={200} value={steps} onChange={(e) => setSteps(+e.target.value)} />
            </Field>
            <Field
              label="Budget · M tokens"
              hint={
                Number.isFinite(budgetM)
                  ? `${fmtTokens(budgetM * 1e6)} cap${capEst ? ` · ≤ ~$${capEst < 10 ? capEst.toFixed(2) : Math.round(capEst)}` : ""}`
                  : "hard spend cap"
              }
            >
              <input type="number" className="input" min={0.5} step={0.5} value={budgetM} onChange={(e) => setBudgetM(+e.target.value)} />
            </Field>
            <Field label="Verification" hint="re-check finished work">
              <select className="input" value={verification} onChange={(e) => { markTouched(); setVerification(e.target.value); }}>
                <option value="off">off — trust the workers</option>
                <option value="normal">normal</option>
                <option value="strict">strict — verify everything</option>
              </select>
            </Field>
            <Field label="Reasoning effort" hint="thinking depth">
              <select className="input" value={effort} onChange={(e) => { markTouched(); setEffort(e.target.value); }}>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="max">max</option>
              </select>
            </Field>
            <Field label="Worker model" hint={providerLabel}>
              <input
                className="input mono"
                list="composer-models"
                value={model}
                onChange={(e) => { markTouched(); setModel(e.target.value); }}
                placeholder="model id"
              />
              <datalist id="composer-models">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            <Field label="Workspace" hint={workspace === "sandbox" ? "isolated, throwaway" : "agents touch real files"}>
              <select
                className="input"
                value={workspace}
                onChange={(e) => { markTouched(); setWorkspace(e.target.value as "sandbox" | "dir"); }}
              >
                <option value="sandbox">Isolated workspace</option>
                <option value="dir">A directory on disk</option>
              </select>
            </Field>
          </div>
          {workspace === "dir" && (
            <p className="tile text-xs leading-relaxed text-ink-dim px-3 py-2.5">
              Agents will read, run and write inside this directory with your permissions. Safe mode still blocks
              destructive commands, but prefer a project you have under version control.
            </p>
          )}
        </div>
        </div>
      </div>

      {error && (
        <div className="mt-3 text-sm text-ink px-3 py-2 rounded-[10px]" style={{ background: "rgb(var(--hi) / 0.06)", border: "1px solid rgb(var(--hi) / 0.2)" }}>
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mt-4">
        <div className="text-2xs">
          {noKey ? (
            <Link href="/settings" className="text-ink underline underline-offset-2">
              Set up a provider in Settings first →
            </Link>
          ) : needsCwd ? (
            <span className="text-ink">Enter the directory the swarm should work in.</span>
          ) : (
            <span className="text-ink-faint">
              {workspace === "sandbox"
                ? config?.sandboxResolved && config.sandboxResolved !== "host"
                  ? `Isolated · ${config.sandboxResolved} sandbox`
                  : "Isolated workspace on this machine"
                : "Runs against your directory"} · ⌘↵ to launch
            </span>
          )}
        </div>
        <button className="btn btn-primary" disabled={!mission.trim() || submitting || noKey || needsCwd} onClick={launch}>
          {submitting && <Spinner size={13} dark />} {mode === "forecast" ? "Launch forecast" : "Launch swarm"}
        </button>
      </div>
    </section>
  );
}

/** Browse server-side directories and pick one as the swarm's working folder. */
function FolderBrowser({ cwd, onPick, onClose }: { cwd: string; onPick: (p: string) => void; onClose: () => void }) {
  const [open, setOpen] = useState(!cwd);
  const [listing, setListing] = useState<{ path: string; parent: string | null; dirs: { name: string; path: string }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const browse = (path?: string) =>
    api
      .listDirs(path)
      .then((l) => { setListing(l); setErr(null); })
      .catch((e: any) => setErr(e?.message || "can't read directory"));

  useEffect(() => {
    if (open && !listing) browse(cwd.trim() || undefined);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <input
          className="input mono text-sm"
          placeholder="/path/to/project — agents will work in this folder"
          value={cwd}
          onChange={(e) => onPick(e.target.value)}
        />
        <button className="btn btn-sm shrink-0" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Hide" : "Browse"}
        </button>
        <button className="btn btn-ghost btn-sm shrink-0" title="Back to an isolated workspace" onClick={onClose}>
          ✕
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
                <button
                  className="btn btn-primary btn-sm shrink-0"
                  onClick={() => { onPick(listing.path); setOpen(false); }}
                >
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
                  <button
                    key={d.path}
                    className="block w-full text-left px-3 py-1.5 text-sm mono text-ink-dim hover:text-ink truncate"
                    onClick={() => browse(d.path)}
                  >
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

function PresetChip({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      className="chip"
      title={title}
      onClick={onClick}
      style={active ? { color: "var(--color-ink)", borderColor: "rgb(var(--hi) / 0.45)", background: "rgb(var(--hi) / 0.05)" } : undefined}
    >
      {children}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-1 gap-2">
        <span className="text-2xs font-medium text-ink-dim">{label}</span>
        {hint && <span className="text-2xs truncate text-ink-faint">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
