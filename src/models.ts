// Saved / reusable prediction models. A model is a named bundle of forecast
// settings (+ an optional frozen fitted artifact) persisted under
// ~/.agentswarm/forecasts/models.json — mirroring the ledger's home, but a
// mutable JSON object rather than an append log. Track records are DERIVED by
// joining the ledger on modelId, never stored here.

import * as path from "path";
import { forecastsDir, loadLedger, brierScore } from "./forecast";
import type { LedgerEntry } from "./forecast";
import { ensureDir, readJson, writeJson, rid } from "./util";
import type { ForecastModel, ModelRecord } from "./types";

export function modelsPath(): string {
  return path.join(forecastsDir(), "models.json");
}

export function loadModels(): ForecastModel[] {
  const f = readJson<{ models?: ForecastModel[] }>(modelsPath(), {});
  return Array.isArray(f.models) ? f.models : [];
}

function saveModels(models: ForecastModel[]): void {
  ensureDir(forecastsDir());
  writeJson(modelsPath(), { v: 1, models });
}

export function getModel(id: string): ForecastModel | null {
  return loadModels().find((m) => m.id === id) ?? null;
}

/** Create or update a model (by id when present). Caller is responsible for clamping tunables. */
export function upsertModel(input: Partial<ForecastModel> & { name: string }): ForecastModel {
  const models = loadModels();
  const now = Date.now();
  if (input.id) {
    const i = models.findIndex((m) => m.id === input.id);
    if (i >= 0) {
      models[i] = { ...models[i], ...input, id: models[i].id, updatedAt: now } as ForecastModel;
      saveModels(models);
      return models[i];
    }
  }
  const model: ForecastModel = {
    id: rid("fm"),
    name: input.name.trim().slice(0, 80),
    domain: input.domain,
    tunables: input.tunables ?? {},
    fitMode: input.fitMode === "frozen" ? "frozen" : "live",
    fitted: input.fitted,
    createdAt: now,
    updatedAt: now,
  };
  models.push(model);
  saveModels(models);
  return model;
}

export function deleteModel(id: string): boolean {
  const models = loadModels();
  const next = models.filter((m) => m.id !== id);
  if (next.length === models.length) return false;
  saveModels(next);
  return true;
}

/** Derive a model's track record from the ledger rows produced with it. */
export function modelTrackRecord(modelId: string, entries: LedgerEntry[] = loadLedger()): ModelRecord {
  const rows = entries.filter((e) => e.modelId === modelId);
  const resolved = rows.filter((e) => e.resolution);
  const briers: number[] = [];
  const vs: number[] = [];
  for (const e of resolved) {
    const b = e.resolution!.brier;
    if (typeof b === "number" && Number.isFinite(b)) briers.push(b);
    // vs market: binary entries with a market price captured at create.
    const o = e.resolution!.outcome;
    if ((o === 0 || o === 1) && e.question.kind === "binary") {
      const mp = e.aggregate.components?.market?.probability ?? e.origin?.marketProbAtCreate;
      const mp2 = typeof mp === "number" ? mp : undefined;
      const myP = e.aggregate.probability;
      if (typeof mp2 === "number" && typeof myP === "number") {
        vs.push(brierScore(myP, o) - brierScore(mp2, o));
      }
    }
  }
  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : undefined);
  return {
    n: rows.length,
    resolved: resolved.length,
    brierMean: mean(briers),
    vsMarket: mean(vs),
  };
}
