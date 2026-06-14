"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { Spinner } from "@/components/atoms";
import { api, ProviderView } from "@/lib/api";
import { useConfig } from "@/lib/hooks";

const NUM_FIELDS: { key: string; label: string; min: number; max: number; hint?: string }[] = [
  { key: "maxWorkers", label: "Agents in parallel", min: 1, max: 256 },
  { key: "maxTasks", label: "Task limit", min: 1, max: 1000 },
  { key: "maxStepsPerTask", label: "Steps per task", min: 3, max: 200 },
  { key: "maxTokensPerRun", label: "Token budget", min: 50_000, max: 2_000_000_000 },
  { key: "verifyMaxAttempts", label: "Verify attempts", min: 1, max: 5, hint: "Retries before a verified task is accepted/failed" },
  { key: "maxToolResultChars", label: "Tool result cap (chars)", min: 4_000, max: 500_000, hint: "Max characters returned from fetch_url / tools" },
];

export default function SettingsPage() {
  const { config, reload, error } = useConfig();
  const [models, setModels] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // local editable fields
  const [tinyfishApiKey, setTinyfishApiKey] = useState("");
  const [fredApiKey, setFredApiKey] = useState("");
  const [metaculusApiKey, setMetaculusApiKey] = useState("");
  const [oddsApiKey, setOddsApiKey] = useState("");
  const [form, setForm] = useState<Record<string, any>>({});
  // Per-provider drafts: key inputs start blank ("leave blank to keep").
  const [provKeys, setProvKeys] = useState<Record<string, string>>({});
  const [provUrls, setProvUrls] = useState<Record<string, string>>({});
  // Sandbox secrets, blank = keep current.
  const [sbxSecrets, setSbxSecrets] = useState<Record<string, string>>({});
  // Crawl integration keys, blank = keep current.
  const [crawlSecrets, setCrawlSecrets] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ status: string; message?: string } | null>(null);
  const [sbxTesting, setSbxTesting] = useState(false);
  const [sbxResult, setSbxResult] = useState<{ kind: string; ok: boolean; detail: string } | null>(null);
  const [searchTesting, setSearchTesting] = useState(false);
  const [searchResult, setSearchResult] = useState<{ ok: boolean; engines: { engine: string; ok: boolean; detail: string }[] } | null>(null);
  const [crawlTesting, setCrawlTesting] = useState(false);
  const [crawlResult, setCrawlResult] = useState<{ ok: boolean; backend: string | null; detail: string } | null>(null);

  // Immediately remove a saved secret ("leave blank to keep" can't clear).
  const clearKey = async (patch: Record<string, any>) => {
    setSaveErr(null);
    try {
      await api.setConfig(patch);
      await reload();
    } catch (e: any) {
      setSaveErr(e?.message || "could not remove the key");
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.validate());
    } catch (e: any) {
      setTestResult({ status: "unknown", message: e?.message || "request failed" });
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    if (config) {
      setForm({
        provider: config.provider,
        model: config.model,
        conductorModel: config.conductorModel,
        cheapModel: config.cheapModel,
        strongModel: config.strongModel,
        maxWorkers: config.maxWorkers,
        maxTasks: config.maxTasks,
        maxStepsPerTask: config.maxStepsPerTask,
        maxTokensPerRun: config.maxTokensPerRun,
        maxToolResultChars: config.maxToolResultChars,
        verification: config.verification,
        verifyMaxAttempts: config.verifyMaxAttempts,
        thinking: config.thinking,
        reasoningEffort: config.reasoningEffort,
        safeMode: config.safeMode,
        searchBackend: config.searchBackend,
        crawlBackend: config.crawlBackend,
        deepcrawlBaseUrl: config.deepcrawlBaseUrl,
        forecastPanelSize: config.forecastPanelSize,
        forecastExtremizeK: config.forecastExtremizeK,
        forecastCoherenceProbe: config.forecastCoherenceProbe,
        forecastMarketWeight: config.forecastMarketWeight,
        forecastDecompose: config.forecastDecompose,
        forecastMaxSubQuestions: config.forecastMaxSubQuestions,
        forecastSimulate: config.forecastSimulate,
        sandboxRuntime: config.sandboxRuntime,
        sandboxImage: config.sandboxImage,
        e2bTemplate: config.e2bTemplate,
        vercelTeamId: config.vercelTeamId,
        vercelProjectId: config.vercelProjectId,
      });
      setProvUrls(Object.fromEntries(config.providers.map((p) => [p.id, p.baseUrl])));
    }
  }, [config]);

  useEffect(() => {
    api.models().then((r) => setModels(r.models)).catch(() => {});
  }, [config?.apiKeySet, config?.provider]);

  const active: ProviderView | undefined = useMemo(
    () => config?.providers.find((p) => p.id === form.provider) ?? config?.providers.find((p) => p.id === config.provider),
    [config, form.provider]
  );

  const save = async () => {
    // Validate numbers locally for an instant, field-specific message.
    // (Number("") is 0, so check emptiness explicitly.)
    for (const f of NUM_FIELDS) {
      const v = form[f.key];
      if (v === "" || v === null || !Number.isFinite(Number(v))) {
        setSaveErr(`${f.label} must be a number`);
        return;
      }
    }
    setSaving(true);
    setSaveErr(null);
    try {
      const patch: Record<string, any> = { ...form };
      if (tinyfishApiKey.trim()) patch.tinyfishApiKey = tinyfishApiKey.trim();
      if (fredApiKey.trim()) patch.fredApiKey = fredApiKey.trim();
      if (metaculusApiKey.trim()) patch.metaculusApiKey = metaculusApiKey.trim();
      if (oddsApiKey.trim()) patch.oddsApiKey = oddsApiKey.trim();
      for (const k of ["e2bApiKey", "modalTokenId", "modalTokenSecret", "vercelToken"]) {
        if (sbxSecrets[k]?.trim()) patch[k] = sbxSecrets[k].trim();
      }
      for (const k of ["firecrawlApiKey", "contextdevApiKey", "deepcrawlApiKey"]) {
        if (crawlSecrets[k]?.trim()) patch[k] = crawlSecrets[k].trim();
      }
      // Per-provider credentials — only fields the operator actually touched.
      const providers: Record<string, { apiKey?: string; baseUrl?: string }> = {};
      for (const p of config?.providers ?? []) {
        const cred: { apiKey?: string; baseUrl?: string } = {};
        if (provKeys[p.id]?.trim()) cred.apiKey = provKeys[p.id].trim();
        if (provUrls[p.id] !== undefined && provUrls[p.id] !== p.baseUrl) cred.baseUrl = provUrls[p.id];
        if (Object.keys(cred).length) providers[p.id] = cred;
      }
      if (Object.keys(providers).length) patch.providers = providers;
      await api.setConfig(patch);
      setProvKeys({});
      setSbxSecrets({});
      setCrawlSecrets({});
      setTinyfishApiKey("");
      setFredApiKey("");
      setMetaculusApiKey("");
      setOddsApiKey("");
      await reload();
      api.models().then((r) => setModels(r.models)).catch(() => {});
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e: any) {
      setSaveErr(e?.message || "save failed");
    } finally {
      setSaving(false);
    }
  };

  if (!config) {
    return (
      <div className="min-h-screen">
        <TopBar />
        <div className="max-w-2xl mx-auto p-16 flex justify-center text-ink-faint">
          {error ? <span className="text-ink">Hub unreachable: {error}</span> : <Spinner />}
        </div>
      </div>
    );
  }

  const modelOptions = models.length ? models : active?.knownModels ?? config.knownModels;
  const priceLine = (m: string) => {
    const p = config.pricing?.[m];
    return p ? `$${p.inMiss}/M in · $${p.out}/M out` : undefined;
  };

  return (
    <div className="min-h-screen">
      <TopBar />
      <main className="max-w-2xl mx-auto px-5 sm:px-8 py-8 pb-24">
        <div className="flex items-baseline gap-3 mb-6">
          <h1 className="text-xl font-display">Settings</h1>
          <Link href="/" className="text-xs text-ink-faint hover:text-ink-dim transition-colors">← back to missions</Link>
        </div>

        <Card title="Model provider" sub="Keys are stored locally in ~/.agentswarm/config.json (chmod 600) and only ever sent to the provider's API.">
          <Field label="Provider">
            <select
              className="input"
              value={form.provider ?? config.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
            >
              {config.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}{p.keySet ? "  ·  key saved" : p.keyRequired ? "" : "  ·  no key needed"}
                </option>
              ))}
            </select>
          </Field>

          {active && (
            <>
              {active.note && <p className="text-xs leading-relaxed text-ink-faint">{active.note}</p>}
              {active.keyRequired ? (
                <Field label={`${active.label} API key`} hint={active.keySet ? `current: ${active.keyMasked}` : "required"}>
                  <input
                    className="input mono"
                    type="password"
                    placeholder={active.keySet ? "•••••• (leave blank to keep)" : "paste your key"}
                    value={provKeys[active.id] ?? ""}
                    onChange={(e) => setProvKeys({ ...provKeys, [active.id]: e.target.value })}
                    autoComplete="off"
                  />
                  {(active.keyUrl || active.keySet) && (
                    <p className="text-2xs mt-1.5 text-ink-faint">
                      {active.keyUrl && (
                        <>
                          Get one at{" "}
                          <a href={active.keyUrl} target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2">
                            {active.keyUrl.replace(/^https?:\/\//, "")}
                          </a>
                        </>
                      )}
                      {active.keySet && (
                        <ClearKey onClear={() => clearKey({ providers: { [active.id]: { apiKey: "" } } })} />
                      )}
                    </p>
                  )}
                </Field>
              ) : (
                <p className="text-xs text-ink-faint">Local server — no API key needed.</p>
              )}
              <Field label="Base URL" hint={`default: ${active.defaultBaseUrl}`}>
                <input
                  className="input mono"
                  value={provUrls[active.id] ?? active.baseUrl}
                  onChange={(e) => setProvUrls({ ...provUrls, [active.id]: e.target.value })}
                />
              </Field>
            </>
          )}

          <div className="flex items-center gap-3 pt-1 flex-wrap">
            <button className="btn" onClick={testConnection} disabled={testing}>
              {testing && <Spinner size={13} />} Test connection
            </button>
            {testResult ? (
              <span className={`text-xs mono ${testResult.status === "ok" ? "text-ink" : "text-ink-dim"}`}>
                {testResult.status === "ok"
                  ? "✓ Connection works"
                  : testResult.status === "invalid"
                    ? `✕ ${testResult.message || "key rejected"}`
                    : `— ${testResult.message || "could not verify"}`}
              </span>
            ) : (
              <span className="text-2xs text-ink-faint">tests the saved provider — save first</span>
            )}
          </div>
        </Card>

        <Card title="Models">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Worker model" hint="does the tasks" sub={priceLine(form.model)}>
              <ModelInput value={form.model ?? ""} options={modelOptions} onChange={(v) => setForm({ ...form, model: v })} listId="worker-models" />
            </Field>
            <Field label="Conductor model" hint="plans & synthesizes" sub={priceLine(form.conductorModel)}>
              <ModelInput value={form.conductorModel ?? ""} options={modelOptions} onChange={(v) => setForm({ ...form, conductorModel: v })} listId="conductor-models" />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <Field label="Cheap tier" hint='spawn model:"cheap" — scouts, bulk extraction' sub={form.cheapModel ? priceLine(form.cheapModel) : "blank = worker model"}>
              <ModelInput value={form.cheapModel ?? ""} options={modelOptions} onChange={(v) => setForm({ ...form, cheapModel: v })} listId="cheap-models" />
            </Field>
            <Field label="Strong tier" hint='spawn model:"strong" — leads, verifiers' sub={form.strongModel ? priceLine(form.strongModel) : "blank = worker model"}>
              <ModelInput value={form.strongModel ?? ""} options={modelOptions} onChange={(v) => setForm({ ...form, strongModel: v })} listId="strong-models" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Field label="Reasoning effort" hint="how hard models think">
              <select className="input" value={form.reasoningEffort} onChange={(e) => setForm({ ...form, reasoningEffort: e.target.value })}>
                <option value="low">low — fastest</option>
                <option value="medium">medium</option>
                <option value="high">high — recommended</option>
                <option value="max">max — slowest, most careful</option>
              </select>
            </Field>
            <Field label="Thinking mode" hint="chain-of-thought">
              <Toggle on={!!form.thinking} onChange={(v) => setForm({ ...form, thinking: v })} label={form.thinking ? "enabled" : "disabled"} />
            </Field>
          </div>
          <p className="text-2xs leading-relaxed text-ink-faint">
            Effort maps to what each provider supports; providers without an effort knob simply ignore it.
          </p>
        </Card>

        <Card title="Web search" sub="Built-in multi-engine search: DuckDuckGo and Bing are scraped in parallel, results are quality-ranked and deduped, and deep mode fetches top pages for quotable passages. TinyFish and context.dev keys each add an engine to the mix (context.dev: relevance-ranked, 1 credit per result; deep mode uses its server-side query fan-out).">
          <Field label="Search engines">
            <select className="input" value={form.searchBackend ?? "auto"} onChange={(e) => setForm({ ...form, searchBackend: e.target.value })}>
              <option value="auto">Auto — all engines, merged</option>
              <option value="tinyfish">TinyFish only</option>
              <option value="contextdev">context.dev only{config.contextdevKeySet ? " · key saved" : ""}</option>
              <option value="ddg">Free engines only (DuckDuckGo + Bing)</option>
            </select>
          </Field>
          <Field label="TinyFish API key" hint={config.tinyfishKeySet ? `current: ${config.tinyfishKeyMasked}` : "optional — extra hosted engine & fetch"}>
            <input
              className="input mono"
              type="password"
              placeholder={config.tinyfishKeySet ? "•••••• (leave blank to keep)" : "optional"}
              value={tinyfishApiKey}
              onChange={(e) => setTinyfishApiKey(e.target.value)}
              autoComplete="off"
            />
            <p className="text-2xs mt-1.5 text-ink-faint">
              TinyFish: <a href="https://docs.tinyfish.ai" target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2">tinyfish.ai</a>
              {config.tinyfishKeySet && <ClearKey onClear={() => clearKey({ tinyfishApiKey: "" })} />}
            </p>
          </Field>

          <div className="flex items-center gap-3 pt-1 flex-wrap">
            <button
              className="btn"
              disabled={searchTesting}
              onClick={async () => {
                setSearchTesting(true);
                setSearchResult(null);
                try {
                  setSearchResult(await api.searchTest());
                } catch (e: any) {
                  setSearchResult({ ok: false, engines: [{ engine: "request", ok: false, detail: e?.message || "failed" }] });
                } finally {
                  setSearchTesting(false);
                }
              }}
            >
              {searchTesting && <Spinner size={13} />} Test web search
            </button>
            {searchResult ? (
              <span className="text-xs mono text-ink-dim">
                {searchResult.engines.map((e) => `${e.ok ? "✓" : "✕"} ${e.engine} (${e.detail})`).join("  ·  ")}
              </span>
            ) : (
              <span className="text-2xs text-ink-faint">runs one real query per engine — save first</span>
            )}
          </div>
        </Card>

        <Card
          title="Crawl integrations"
          sub="Gives agents a crawl_site tool that ingests whole sites as markdown files, and upgrades fetch_url with JS rendering and clean markdown. Auto uses the first configured service (context.dev → Firecrawl → deepcrawl)."
        >
          <Field
            label="Crawl backend"
            hint={
              (form.crawlBackend ?? "auto") === "auto"
                ? `currently resolves to: ${config.crawlResolved ?? "none configured"}`
                : undefined
            }
          >
            <select
              className="input"
              value={form.crawlBackend ?? "auto"}
              onChange={(e) => setForm({ ...form, crawlBackend: e.target.value })}
            >
              <option value="auto">Auto — first configured</option>
              <option value="firecrawl">Firecrawl{config.firecrawlKeySet ? " · key saved" : ""}</option>
              <option value="contextdev">context.dev{config.contextdevKeySet ? " · key saved" : ""}</option>
              <option value="deepcrawl">deepcrawl (custom){config.deepcrawlKeySet ? " · key saved" : ""}</option>
              <option value="off">Off — disable crawl_site</option>
            </select>
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field
              label="Firecrawl API key"
              hint={config.firecrawlKeySet ? `current: ${config.firecrawlKeyMasked}` : "firecrawl.dev"}
            >
              <input
                className="input mono" type="password" autoComplete="off"
                placeholder={config.firecrawlKeySet ? "•••••• (leave blank to keep)" : "fc-..."}
                value={crawlSecrets.firecrawlApiKey ?? ""}
                onChange={(e) => setCrawlSecrets({ ...crawlSecrets, firecrawlApiKey: e.target.value })}
              />
            </Field>
            <Field
              label="context.dev API key"
              hint={config.contextdevKeySet ? `current: ${config.contextdevKeyMasked}` : "context.dev"}
            >
              <input
                className="input mono" type="password" autoComplete="off"
                placeholder={config.contextdevKeySet ? "•••••• (leave blank to keep)" : "api key"}
                value={crawlSecrets.contextdevApiKey ?? ""}
                onChange={(e) => setCrawlSecrets({ ...crawlSecrets, contextdevApiKey: e.target.value })}
              />
            </Field>
            <Field
              label="deepcrawl API key"
              hint={config.deepcrawlKeySet ? `current: ${config.deepcrawlKeyMasked}` : "custom crawler"}
            >
              <input
                className="input mono" type="password" autoComplete="off"
                placeholder={config.deepcrawlKeySet ? "•••••• (leave blank to keep)" : "api key"}
                value={crawlSecrets.deepcrawlApiKey ?? ""}
                onChange={(e) => setCrawlSecrets({ ...crawlSecrets, deepcrawlApiKey: e.target.value })}
              />
            </Field>
            <Field label="deepcrawl base URL" hint="custom crawler endpoint (POST /crawl)">
              <input
                className="input mono"
                placeholder="https://crawler.example.com"
                value={form.deepcrawlBaseUrl ?? ""}
                onChange={(e) => setForm({ ...form, deepcrawlBaseUrl: e.target.value })}
              />
            </Field>
          </div>

          {(config.firecrawlKeySet || config.contextdevKeySet || config.deepcrawlKeySet) && (
            <p className="text-2xs text-ink-faint">
              Remove a saved key:
              {config.firecrawlKeySet && <ClearKey label="firecrawl" onClear={() => clearKey({ firecrawlApiKey: "" })} />}
              {config.contextdevKeySet && <ClearKey label="context.dev" onClear={() => clearKey({ contextdevApiKey: "" })} />}
              {config.deepcrawlKeySet && <ClearKey label="deepcrawl" onClear={() => clearKey({ deepcrawlApiKey: "" })} />}
            </p>
          )}

          <div className="flex items-center gap-3 pt-1 flex-wrap">
            <button
              className="btn"
              disabled={crawlTesting}
              onClick={async () => {
                setCrawlTesting(true);
                setCrawlResult(null);
                try {
                  setCrawlResult(await api.crawlTest());
                } catch (e: any) {
                  setCrawlResult({ ok: false, backend: null, detail: e?.message || "request failed" });
                } finally {
                  setCrawlTesting(false);
                }
              }}
            >
              {crawlTesting && <Spinner size={13} />} Test crawl backend
            </button>
            {crawlResult ? (
              <span className={`text-xs mono ${crawlResult.ok ? "text-ink" : "text-ink-dim"}`}>
                {crawlResult.ok
                  ? `✓ ${crawlResult.backend} works — ${crawlResult.detail}`
                  : `✕ ${crawlResult.backend ?? "none"}: ${crawlResult.detail}`}
              </span>
            ) : (
              <span className="text-2xs text-ink-faint">scrapes one page with the saved keys — save first</span>
            )}
          </div>
        </Card>

        <Card
          title="Forecasting"
          sub="Forecast runs put an independent forecaster panel behind every question and combine it mechanically (extremized geometric mean of odds). Open-ended questions fan out into several resolvable sub-forecasts. Manifold, Polymarket, Kalshi, and PredictIt odds are keyless; a free Metaculus token adds its forecaster crowd, a free Odds API key adds de-vigged sportsbook consensus, and a free FRED key adds economic series to the time_series tool."
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Panel size" hint="independent forecasters per question (3–11)">
              <input
                type="number" className="input" min={3} max={11}
                value={form.forecastPanelSize ?? 5}
                onChange={(e) => setForm({ ...form, forecastPanelSize: e.target.value })}
              />
            </Field>
            <Field label="Extremization k" hint="aggregation exponent (auto-tunes once ≥30 forecasts resolve)">
              <input
                type="number" className="input" min={1} max={4} step={0.25}
                value={form.forecastExtremizeK ?? 2.5}
                onChange={(e) => setForm({ ...form, forecastExtremizeK: e.target.value })}
              />
            </Field>
            <Field label="Market anchor weight" hint="base blend toward a verified market price, ×liquidity (0 disables; auto-tunes once ≥20 resolve)">
              <input
                type="number" className="input" min={0} max={1} step={0.05}
                value={form.forecastMarketWeight ?? 0.4}
                onChange={(e) => setForm({ ...form, forecastMarketWeight: e.target.value })}
              />
            </Field>
            <Field label="Max sub-forecasts" hint="cap when an open question decomposes (1–8)">
              <input
                type="number" className="input" min={1} max={8}
                value={form.forecastMaxSubQuestions ?? 6}
                onChange={(e) => setForm({ ...form, forecastMaxSubQuestions: e.target.value })}
              />
            </Field>
            <Field label="Coherence probe" hint="engine re-asks the question inverted and folds the flipped answer into the panel — counters affirmative-framing bias">
              <Toggle
                on={!!form.forecastCoherenceProbe}
                onChange={(v) => setForm({ ...form, forecastCoherenceProbe: v })}
                label={form.forecastCoherenceProbe ? "on" : "off"}
              />
            </Field>
            <Field label="Decompose open questions" hint="fan an open-ended question out into several resolvable sub-forecasts (--single overrides per run)">
              <Toggle
                on={!!form.forecastDecompose}
                onChange={(v) => setForm({ ...form, forecastDecompose: v })}
                label={form.forecastDecompose ? "on" : "off"}
              />
            </Field>
            <Field label="Scenario simulation" hint="grounded Monte Carlo over the sub-forecasts: ranked scenarios + driver tornado, a cross-check that earns headline weight only on the resolved ledger (auto on decomposed questions; --simulate forces it)">
              <Toggle
                on={!!form.forecastSimulate}
                onChange={(v) => setForm({ ...form, forecastSimulate: v })}
                label={form.forecastSimulate ? "on" : "off"}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="FRED API key" hint={config.fredKeySet ? `current: ${config.fredKeyMasked}` : "free — fred.stlouisfed.org"}>
              <input
                className="input mono" type="password" autoComplete="off"
                placeholder={config.fredKeySet ? "•••••• (leave blank to keep)" : "optional — FRED economic series"}
                value={fredApiKey}
                onChange={(e) => setFredApiKey(e.target.value)}
              />
            </Field>
            <Field label="Metaculus API token" hint={config.metaculusKeySet ? `current: ${config.metaculusKeyMasked}` : "free — metaculus.com"}>
              <input
                className="input mono" type="password" autoComplete="off"
                placeholder={config.metaculusKeySet ? "•••••• (leave blank to keep)" : "optional — Metaculus crowd odds"}
                value={metaculusApiKey}
                onChange={(e) => setMetaculusApiKey(e.target.value)}
              />
            </Field>
            <Field label="The Odds API key" hint={config.oddsKeySet ? `current: ${config.oddsKeyMasked}` : "free tier — the-odds-api.com"}>
              <input
                className="input mono" type="password" autoComplete="off"
                placeholder={config.oddsKeySet ? "•••••• (leave blank to keep)" : "optional — de-vigged sportsbook consensus"}
                value={oddsApiKey}
                onChange={(e) => setOddsApiKey(e.target.value)}
              />
            </Field>
          </div>
          <p className="text-2xs text-ink-faint">
            Keys:{" "}
            <a href="https://fred.stlouisfed.org/docs/api/api_key.html" target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2">
              fred.stlouisfed.org
            </a>{" "}
            ·{" "}
            <a href="https://www.metaculus.com/aib/" target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2">
              metaculus.com
            </a>{" "}
            ·{" "}
            <a href="https://the-odds-api.com/" target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2">
              the-odds-api.com
            </a>
            {config.fredKeySet && <ClearKey label="FRED" onClear={() => clearKey({ fredApiKey: "" })} />}
            {config.metaculusKeySet && <ClearKey label="Metaculus" onClear={() => clearKey({ metaculusApiKey: "" })} />}
            {config.oddsKeySet && <ClearKey label="Odds API" onClear={() => clearKey({ oddsApiKey: "" })} />}
          </p>
        </Card>

        <Card
          title="Sandbox"
          sub="Where agents execute shell commands for isolated runs. The default is a private per-run workspace on this machine, with nothing to install. Pick a container or cloud runtime for stronger isolation, or Auto to use the strongest one you've configured (E2B → Modal → Vercel → Docker → host)."
        >
          <Field
            label="Runtime"
            hint={
              (form.sandboxRuntime ?? "host") === "auto"
                ? `currently resolves to: ${config.sandboxResolved}`
                : undefined
            }
          >
            <select
              className="input"
              value={form.sandboxRuntime ?? "host"}
              onChange={(e) => setForm({ ...form, sandboxRuntime: e.target.value })}
            >
              <option value="host">This machine — isolated workspace (default)</option>
              <option value="docker">Local container (Docker){config.dockerUp ? " · daemon up" : " · daemon not running"}</option>
              <option value="e2b">E2B cloud{config.e2bKeySet ? " · key saved" : ""}</option>
              <option value="modal">Modal cloud{config.modalConfigured ? " · configured" : ""}</option>
              <option value="vercel">Vercel sandbox{config.vercelConfigured ? " · configured" : ""}</option>
              <option value="auto">Auto — strongest available</option>
            </select>
          </Field>

          <Field label="Container image" hint="docker & modal runtimes">
            <input
              className="input mono"
              value={form.sandboxImage ?? ""}
              onChange={(e) => setForm({ ...form, sandboxImage: e.target.value })}
              placeholder="node:22-bookworm"
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="E2B API key" hint={config.e2bKeySet ? `current: ${config.e2bKeyMasked}` : "e2b.dev"}>
              <input
                className="input mono" type="password" autoComplete="off"
                placeholder={config.e2bKeySet ? "•••••• (leave blank to keep)" : "e2b_..."}
                value={sbxSecrets.e2bApiKey ?? ""}
                onChange={(e) => setSbxSecrets({ ...sbxSecrets, e2bApiKey: e.target.value })}
              />
            </Field>
            <Field label="E2B template" hint="sandbox template id">
              <input
                className="input mono"
                value={form.e2bTemplate ?? ""}
                onChange={(e) => setForm({ ...form, e2bTemplate: e.target.value })}
                placeholder="base"
              />
            </Field>
            <Field label="Modal token id" hint={config.modalConfigured ? "configured" : "modal.com"}>
              <input
                className="input mono" type="password" autoComplete="off"
                placeholder={config.modalConfigured ? "•••••• (leave blank to keep)" : "ak-..."}
                value={sbxSecrets.modalTokenId ?? ""}
                onChange={(e) => setSbxSecrets({ ...sbxSecrets, modalTokenId: e.target.value })}
              />
            </Field>
            <Field label="Modal token secret">
              <input
                className="input mono" type="password" autoComplete="off"
                placeholder={config.modalConfigured ? "•••••• (leave blank to keep)" : "as-..."}
                value={sbxSecrets.modalTokenSecret ?? ""}
                onChange={(e) => setSbxSecrets({ ...sbxSecrets, modalTokenSecret: e.target.value })}
              />
            </Field>
            <Field label="Vercel token" hint={config.vercelConfigured ? "configured" : "vercel.com"}>
              <input
                className="input mono" type="password" autoComplete="off"
                placeholder={config.vercelConfigured ? "•••••• (leave blank to keep)" : "access token"}
                value={sbxSecrets.vercelToken ?? ""}
                onChange={(e) => setSbxSecrets({ ...sbxSecrets, vercelToken: e.target.value })}
              />
            </Field>
            <Field label="Vercel team / project">
              <div className="flex gap-2">
                <input
                  className="input mono" placeholder="team id"
                  value={form.vercelTeamId ?? ""}
                  onChange={(e) => setForm({ ...form, vercelTeamId: e.target.value })}
                />
                <input
                  className="input mono" placeholder="project id"
                  value={form.vercelProjectId ?? ""}
                  onChange={(e) => setForm({ ...form, vercelProjectId: e.target.value })}
                />
              </div>
            </Field>
          </div>

          {(config.e2bKeySet || config.modalConfigured || config.vercelConfigured) && (
            <p className="text-2xs text-ink-faint">
              Remove a saved key:
              {config.e2bKeySet && <ClearKey label="E2B" onClear={() => clearKey({ e2bApiKey: "" })} />}
              {config.modalConfigured && <ClearKey label="Modal" onClear={() => clearKey({ modalTokenId: "", modalTokenSecret: "" })} />}
              {config.vercelConfigured && <ClearKey label="Vercel" onClear={() => clearKey({ vercelToken: "" })} />}
            </p>
          )}

          <div className="flex items-center gap-3 pt-1 flex-wrap">
            <button
              className="btn"
              disabled={sbxTesting}
              onClick={async () => {
                setSbxTesting(true);
                setSbxResult(null);
                try {
                  setSbxResult(await api.sandboxTest(form.sandboxRuntime === "auto" ? undefined : form.sandboxRuntime));
                } catch (e: any) {
                  setSbxResult({ kind: form.sandboxRuntime ?? "auto", ok: false, detail: e?.message || "request failed" });
                } finally {
                  setSbxTesting(false);
                }
              }}
            >
              {sbxTesting && <Spinner size={13} />} Test sandbox
            </button>
            {sbxResult ? (
              <span className={`text-xs mono ${sbxResult.ok ? "text-ink" : "text-ink-dim"}`}>
                {sbxResult.ok ? `✓ ${sbxResult.kind} works` : `✕ ${sbxResult.kind}: ${sbxResult.detail}`}
              </span>
            ) : (
              <span className="text-2xs text-ink-faint">boots the saved runtime, runs a command, tears down — save first</span>
            )}
          </div>
        </Card>

        <Card title="Swarm defaults" sub="Starting values for new runs — every launch can override them.">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {NUM_FIELDS.map((f) => (
              <Field key={f.key} label={f.label}>
                <input
                  type="number"
                  className="input"
                  min={f.min}
                  max={f.max}
                  value={form[f.key] ?? ""}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value === "" ? "" : +e.target.value })}
                />
              </Field>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Field label="Verification" hint="verifier agents re-check work">
              <select className="input" value={form.verification} onChange={(e) => setForm({ ...form, verification: e.target.value })}>
                <option value="off">off</option>
                <option value="normal">normal</option>
                <option value="strict">strict</option>
              </select>
            </Field>
            <Field label="Safe mode" hint="block risky shell/paths">
              <Toggle on={!!form.safeMode} onChange={(v) => setForm({ ...form, safeMode: v })} label={form.safeMode ? "on" : "off"} />
            </Field>
          </div>
        </Card>

        <div
          className="sticky bottom-0 -mx-5 sm:-mx-8 px-5 sm:px-8 py-4 flex items-center justify-between gap-3"
          style={{
            background: "linear-gradient(transparent, color-mix(in oklab, var(--color-bg) 90%, transparent) 30%)",
            backdropFilter: "blur(8px)",
          }}
        >
          <span className={`text-xs min-w-0 truncate ${saveErr ? "text-ink" : "text-ink-faint"}`}>
            {saveErr || "Changes apply to new runs."}
          </span>
          <button className="btn btn-primary shrink-0" onClick={save} disabled={saving}>
            {saving ? <Spinner size={13} dark /> : saved ? "Saved ✓" : "Save settings"}
          </button>
        </div>
      </main>
    </div>
  );
}

/** Inline "remove this saved secret" action — blank-to-keep fields can't clear. */
function ClearKey({ label, onClear }: { label?: string; onClear: () => void }) {
  return (
    <button
      type="button"
      className="ml-2 underline underline-offset-2 hover:text-ink transition-colors"
      onClick={onClear}
    >
      {label ? `clear ${label}` : "remove saved key"}
    </button>
  );
}

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="panel p-5 mb-5">
      <h2 className={`font-semibold text-base${sub ? "" : " mb-4"}`}>{title}</h2>
      {sub && <p className="text-xs mt-0.5 mb-4 leading-relaxed text-ink-faint">{sub}</p>}
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Field({ label, hint, sub, children }: { label: string; hint?: string; sub?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-1.5 gap-2">
        <span className="text-xs font-medium text-ink-dim">{label}</span>
        {hint && <span className="text-2xs truncate text-ink-faint">{hint}</span>}
      </div>
      {children}
      {sub && <p className="text-2xs mono mt-1.5 text-ink-faint">{sub}</p>}
    </label>
  );
}

/** Free-text model field with suggestions — supports any provider's ids. */
function ModelInput({ value, options, onChange, listId }: { value: string; options: string[]; onChange: (v: string) => void; listId: string }) {
  return (
    <>
      <input className="input mono" value={value} list={listId} onChange={(e) => onChange(e.target.value)} placeholder="model id" />
      <datalist id={listId}>
        {options.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className="input flex items-center justify-between"
      style={{ cursor: "pointer" }}
    >
      <span className={on ? "text-ink" : "text-ink-faint"}>{label}</span>
      <span
        className="relative rounded-full transition-colors shrink-0"
        style={{ width: 38, height: 22, background: on ? "var(--color-ink)" : "rgb(var(--hi) / 0.15)" }}
      >
        <span
          className="absolute rounded-full transition-all"
          style={{ width: 16, height: 16, top: 3, left: on ? 19 : 3, background: on ? "var(--color-bg)" : "var(--color-ink-faint)" }}
        />
      </span>
    </button>
  );
}
