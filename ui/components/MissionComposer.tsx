"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, PublicConfig, DomainDetection, ForecastModelView } from "@/lib/api";
import { domainLabel, fmtTokens } from "@/lib/format";
import { Spinner } from "./atoms";

/** Which forecast knobs to surface per domain (mirrors each pack's declared knobs). */
const KNOBS_BY_DOMAIN: Record<string, string[]> = {
  sports: ["panelSize", "sportsMarketWeight", "simulate"],
  finance: ["panelSize", "marketWeight", "extremizeK", "simulate"],
  macro: ["panelSize", "marketWeight", "extremizeK", "decompose", "maxSubQuestions"],
  elections: ["panelSize", "marketWeight", "extremizeK", "coherenceProbe"],
  construction: ["panelSize", "decompose", "maxSubQuestions", "simulate"],
  business: ["panelSize", "extremizeK", "decompose", "maxSubQuestions", "marketWeight"],
  generic: ["panelSize", "marketWeight", "extremizeK", "decompose", "coherenceProbe", "simulate", "maxSubQuestions"],
};

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

  // Forecast intent + saved models + per-run tunables.
  const [savedModels, setSavedModels] = useState<ForecastModelView[]>([]);
  const [modelId, setModelId] = useState("");
  const [detected, setDetected] = useState<DomainDetection | null>(null);
  const [domainOverride, setDomainOverride] = useState("");
  const [fc, setFc] = useState({ extremizeK: 2.5, marketWeight: 0.4, sportsMarketWeight: 0.75, decompose: true, maxSubQuestions: 6, coherenceProbe: true, simulate: false });
  const [fcTouched, setFcTouched] = useState<Record<string, boolean>>({});
  const detectSeq = useRef(0);

  const effectiveDomain = domainOverride || detected?.domain || "generic";
  const relevantKnobs =
    effectiveDomain === detected?.domain && detected?.relevantKnobs?.length
      ? detected.relevantKnobs
      : KNOBS_BY_DOMAIN[effectiveDomain] ?? KNOBS_BY_DOMAIN.generic;
  const markFc = (k: string) => setFcTouched((t) => ({ ...t, [k]: true }));

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
    setFc({
      extremizeK: config.forecastExtremizeK ?? 2.5,
      marketWeight: config.forecastMarketWeight ?? 0.4,
      sportsMarketWeight: config.forecastSportsMarketWeight ?? 0.75,
      decompose: config.forecastDecompose ?? true,
      maxSubQuestions: config.forecastMaxSubQuestions ?? 6,
      coherenceProbe: config.forecastCoherenceProbe ?? true,
      simulate: config.forecastSimulate ?? false,
    });
  }, [config]);

  // Load saved models once (forecast picker).
  useEffect(() => {
    api.forecastModels().then((r) => setSavedModels(r.models)).catch(() => {});
  }, []);

  // Debounced domain detection while typing a forecast question (race-guarded).
  useEffect(() => {
    if (mode !== "forecast" || !mission.trim()) {
      setDetected(null);
      return;
    }
    const seq = ++detectSeq.current;
    const t = setTimeout(() => {
      api
        .detectDomain(mission.trim())
        .then((d) => {
          if (seq === detectSeq.current) setDetected(d);
        })
        .catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [mission, mode]);

  const applyModel = (m: ForecastModelView) => {
    touched.current = true;
    setModelId(m.id);
    // An auto-detect model (no domain) must CLEAR any stale manual override,
    // else effectiveDomain stays pinned to the old pick.
    setDomainOverride(m.domain ?? "");
    const t = m.tunables as Record<string, unknown>;
    if (typeof t.panelSize === "number") setPanelSize(t.panelSize);
    setFc((prev) => ({
      extremizeK: typeof t.extremizeK === "number" ? t.extremizeK : prev.extremizeK,
      marketWeight: typeof t.marketWeight === "number" ? t.marketWeight : prev.marketWeight,
      sportsMarketWeight: typeof t.sportsMarketWeight === "number" ? t.sportsMarketWeight : prev.sportsMarketWeight,
      decompose: typeof t.decompose === "boolean" ? t.decompose : prev.decompose,
      maxSubQuestions: typeof t.maxSubQuestions === "number" ? t.maxSubQuestions : prev.maxSubQuestions,
      coherenceProbe: typeof t.coherenceProbe === "boolean" ? t.coherenceProbe : prev.coherenceProbe,
      simulate: typeof t.simulate === "boolean" ? t.simulate : prev.simulate,
    }));
    // Only mark recognized knobs as touched (panelSize is sent unconditionally;
    // `overrides` is not a knob) so the launch payload + reset-button logic stay honest.
    const nt: Record<string, boolean> = {};
    for (const k of ["extremizeK", "marketWeight", "sportsMarketWeight", "decompose", "maxSubQuestions", "coherenceProbe", "simulate"]) {
      if (k in t) nt[k] = true;
    }
    setFcTouched(nt);
  };

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
          ...(mode === "forecast"
            ? {
                ...(resolutionDate ? { resolutionDate } : {}),
                panelSize: clamp(panelSize, 3, 11, 5),
                ...(effectiveDomain !== "generic" ? { domainPack: effectiveDomain } : {}),
                ...(modelId ? { forecastModelId: modelId } : {}),
                ...(fcTouched.extremizeK ? { forecastExtremizeK: fc.extremizeK } : {}),
                ...(fcTouched.marketWeight ? { forecastMarketWeight: fc.marketWeight } : {}),
                ...(fcTouched.sportsMarketWeight ? { forecastSportsMarketWeight: fc.sportsMarketWeight } : {}),
                ...(fcTouched.decompose ? { forecastDecompose: fc.decompose } : {}),
                ...(fcTouched.maxSubQuestions ? { forecastMaxSubQuestions: fc.maxSubQuestions } : {}),
                ...(fcTouched.coherenceProbe ? { forecastCoherenceProbe: fc.coherenceProbe } : {}),
                ...(fcTouched.simulate ? { forecastSimulate: fc.simulate } : {}),
                forecastOverrides: {
                  extremizeK: !!fcTouched.extremizeK,
                  marketWeight: !!fcTouched.marketWeight,
                  sportsMarketWeight: !!fcTouched.sportsMarketWeight,
                },
              }
            : {}),
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
        className="input resize-none leading-relaxed"
        rows={3}
        autoFocus
        placeholder={
          mode === "forecast"
            ? 'Ask anything about the future — "Who will win the game tonight?" or "Will X ship before year end?" — and get a calibrated probability from an independent forecaster panel. Leave the date blank and we will infer when it resolves.'
            : "Describe a mission — the swarm decomposes it into parallel tasks and runs them autonomously."
        }
        value={mission}
        onChange={(e) => setMission(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") launch();
        }}
      />

      {mode === "forecast" && (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <DomainPicker detected={detected} override={domainOverride} onChange={(d) => { setDomainOverride(d); markTouched(); }} />
          <ModelPicker
            models={savedModels}
            value={modelId}
            onPick={(id) => {
              if (!id) { setModelId(""); return; }
              const m = savedModels.find((x) => x.id === id);
              if (m) applyModel(m);
            }}
          />
          <span className="text-2xs text-ink-faint">model & settings tune automatically — open Options to adjust</span>
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
          {mode === "forecast" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-2xs text-ink-faint">Forecast tuning</span>
                <span className="chip text-ink">{domainLabel(effectiveDomain)}</span>
                {Object.keys(fcTouched).some((k) => fcTouched[k]) && (
                  <button className="btn btn-ghost btn-sm" onClick={() => { setFcTouched({}); markTouched(); }}>
                    reset to domain defaults
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Field label="Resolution date" hint="inferred if blank">
                  <input type="date" className="input" value={resolutionDate} onChange={(e) => { markTouched(); setResolutionDate(e.target.value); }} />
                </Field>
                {relevantKnobs.includes("panelSize") && (
                  <Field label="Forecaster panel" hint="independent panelists">
                    <input type="number" className="input" min={3} max={11} value={panelSize} onChange={(e) => { markTouched(); setPanelSize(+e.target.value); }} />
                  </Field>
                )}
                {relevantKnobs.includes("extremizeK") && (
                  <Field label="Extremize k" hint="confidence sharpening">
                    <input type="number" className="input" min={1} max={4} step={0.1} value={fc.extremizeK} onChange={(e) => { markFc("extremizeK"); setFc((f) => ({ ...f, extremizeK: +e.target.value })); }} />
                  </Field>
                )}
                {relevantKnobs.includes("marketWeight") && (
                  <Field label="Market weight" hint="pull toward markets">
                    <input type="number" className="input" min={0} max={1} step={0.05} value={fc.marketWeight} onChange={(e) => { markFc("marketWeight"); setFc((f) => ({ ...f, marketWeight: +e.target.value })); }} />
                  </Field>
                )}
                {relevantKnobs.includes("sportsMarketWeight") && (
                  <Field label="Sports line weight" hint="pull toward the book">
                    <input type="number" className="input" min={0} max={1} step={0.05} value={fc.sportsMarketWeight} onChange={(e) => { markFc("sportsMarketWeight"); setFc((f) => ({ ...f, sportsMarketWeight: +e.target.value })); }} />
                  </Field>
                )}
                {relevantKnobs.includes("maxSubQuestions") && (
                  <Field label="Max sub-forecasts" hint="decomposition width">
                    <input type="number" className="input" min={1} max={8} value={fc.maxSubQuestions} onChange={(e) => { markFc("maxSubQuestions"); setFc((f) => ({ ...f, maxSubQuestions: +e.target.value })); }} />
                  </Field>
                )}
                {relevantKnobs.includes("decompose") && (
                  <Field label="Decompose" hint="split into sub-forecasts">
                    <select className="input" value={fc.decompose ? "yes" : "no"} onChange={(e) => { markFc("decompose"); setFc((f) => ({ ...f, decompose: e.target.value === "yes" })); }}>
                      <option value="yes">yes</option>
                      <option value="no">no — single question</option>
                    </select>
                  </Field>
                )}
                {relevantKnobs.includes("coherenceProbe") && (
                  <Field label="Coherence probe" hint="re-asks inverted to cancel yes-bias">
                    <select className="input" value={fc.coherenceProbe ? "yes" : "no"} onChange={(e) => { markFc("coherenceProbe"); setFc((f) => ({ ...f, coherenceProbe: e.target.value === "yes" })); }}>
                      <option value="yes">yes</option>
                      <option value="no">no</option>
                    </select>
                  </Field>
                )}
                {relevantKnobs.includes("simulate") && (
                  <Field label="Scenario simulation" hint="Monte Carlo cross-check">
                    <select className="input" value={fc.simulate ? "yes" : "no"} onChange={(e) => { markFc("simulate"); setFc((f) => ({ ...f, simulate: e.target.value === "yes" })); }}>
                      <option value="no">auto</option>
                      <option value="yes">force on</option>
                    </select>
                  </Field>
                )}
              </div>
            </div>
          )}
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
    // Each time the browser opens, refetch from the typed path so a manually
    // entered path is honored (this intentionally resets in-browser navigation
    // back to that path rather than showing a stale listing).
    if (open) browse(cwd.trim() || undefined);
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

/** Auto-detected domain chip with an override dropdown. */
function DomainPicker({ detected, override, onChange }: { detected: DomainDetection | null; override: string; onChange: (d: string) => void }) {
  // Exclude the detected domain (it's the value="" auto option) and any
  // "generic" entry (rendered once below) so nothing appears twice.
  const alts = (detected?.alternatives ?? []).filter((a) => a.domain !== detected?.domain && a.domain !== "generic");
  const current = override || detected?.domain || "";
  const detLabel = detected && detected.domain !== "generic" ? `${detected.label}${override ? "" : " · auto"}` : "General";
  return (
    <label className="flex items-center gap-1.5" title="Detected forecasting domain — override if it's wrong">
      <span className="text-2xs text-ink-faint" aria-hidden="true">⌖</span>
      <select
        className="input !py-1 !text-xs !w-auto"
        aria-label="Forecast domain"
        value={current}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{detLabel}</option>
        {alts.map((a) => (
          <option key={a.domain} value={a.domain}>
            {a.label}
          </option>
        ))}
        {detected?.domain !== "generic" && <option value="generic">General</option>}
      </select>
    </label>
  );
}

/** Saved-model picker — "Auto" or a named reusable model with its track record. */
function ModelPicker({ models, value, onPick }: { models: ForecastModelView[]; value: string; onPick: (id: string) => void }) {
  return (
    <label className="flex items-center gap-1.5" title="Apply a saved prediction model (settings + frozen fit)">
      <span className="text-2xs text-ink-faint" aria-hidden="true">⚙</span>
      <select className="input !py-1 !text-xs !w-auto" aria-label="Saved prediction model" value={value} onChange={(e) => onPick(e.target.value)}>
        <option value="">Auto · no saved model</option>
        {models.map((m) => {
          const rec = m.record;
          const tail = rec?.resolved ? ` · ${rec.resolved} resolved${typeof rec.brierMean === "number" ? ` · Brier ${rec.brierMean.toFixed(2)}` : ""}` : "";
          return (
            <option key={m.id} value={m.id}>
              {m.name}{m.domain ? ` (${m.domain})` : ""}{m.fitMode === "frozen" ? " ❄" : ""}{tail}
            </option>
          );
        })}
      </select>
    </label>
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
