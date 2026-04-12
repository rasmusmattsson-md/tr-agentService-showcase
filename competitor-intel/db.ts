/**
 * All persistence in one place:
 * - Supabase: metric cache, run log, data table, entity resolution
 * - Redis: job state (optional; gracefully disabled if REDIS_URL is unset)
 * - Artifacts: run record for audit trail
 */
import { createClient } from "@supabase/supabase-js";
import { createClient as createRedisClient } from "redis";
import {
  createNewArtifactRun,
  getOrCreateNewArtifact,
  updateNewArtifactRun,
} from "../src/Artifacts";
import type { Metric, MetricDef, TierStep, ExtractionSignal, CompanyInput, RunContext } from "./types";

// ─── Supabase ─────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function getCachedMetrics(
  companyId: string,
  metricKeys: string[],
  maxAgeHours = 168
): Promise<Record<string, Metric>> {
  const cutoff = new Date(Date.now() - maxAgeHours * 3_600_000).toISOString();
  const { data } = await supabase
    .from("metric_cache")
    .select("metric_key, value, source")
    .eq("company_id", companyId)
    .in("metric_key", metricKeys)
    .gte("extracted_at", cutoff);

  return Object.fromEntries((data ?? []).map((r) => [r.metric_key, { value: r.value, source: r.source }]));
}

export async function upsertMetrics(
  companyId: string,
  reportUrl: string,
  metrics: Record<string, Metric>
): Promise<void> {
  const rows = Object.entries(metrics)
    .filter(([, m]) => m.value != null)
    .map(([key, m]) => ({
      company_id: companyId,
      metric_key: key,
      value: String(m.value),
      source: m.source,
      report_url: reportUrl,
      extracted_at: new Date().toISOString(),
    }));

  if (rows.length === 0) return;
  await supabase.from("metric_cache").upsert(rows, { onConflict: "company_id,metric_key" });
}

export async function getDataCacheMetrics(
  companyName: string,
  metricKeys: string[],
  asOfDate: string
): Promise<Record<string, Metric>> {
  const { data: entity } = await supabase
    .from("entities")
    .select("id")
    .ilike("name", companyName)
    .limit(1)
    .maybeSingle();

  if (!entity?.id) return {};

  const { data } = await supabase
    .from("data")
    .select("metric_key, value, source")
    .eq("entity_id", entity.id)
    .eq("as_of_date", asOfDate)
    .in("metric_key", metricKeys);

  return Object.fromEntries((data ?? []).map((r) => [r.metric_key, { value: r.value?.toString() ?? null, source: r.source }]));
}

export async function writeRunLog(params: {
  runId: string;
  companyId: string;
  status: string;
  signal?: string;
  reportUrl?: string | null;
  steps?: TierStep[];
  error?: string | null;
  finishedAt?: Date;
}): Promise<void> {
  await supabase.from("run_log").upsert(
    {
      run_id: params.runId,
      company_id: params.companyId,
      status: params.status,
      signal: params.signal ?? null,
      report_url: params.reportUrl ?? null,
      steps: params.steps ?? null,
      error: params.error ?? null,
      finished_at: params.finishedAt?.toISOString() ?? null,
    },
    { onConflict: "run_id" }
  );
}

// ─── Redis job state ──────────────────────────────────────────────────────────

type JobStatus = "pending" | "finding_report" | "parsing" | "done" | "failed";

interface JobState {
  runId: string;
  companyId: string;
  status: JobStatus;
  step: string;
  startedAt: string;
  updatedAt: string;
  reportUrl?: string | null;
  error?: string | null;
}

let _redis: ReturnType<typeof createRedisClient> | null = null;
let _redisDisabled = false;

async function getRedis() {
  if (_redisDisabled || !process.env.REDIS_URL) { _redisDisabled = true; return null; }
  if (_redis) return _redis;
  try {
    _redis = createRedisClient({ url: process.env.REDIS_URL });
    _redis.on("error", () => {});
    await _redis.connect();
    return _redis;
  } catch {
    _redisDisabled = true;
    return null;
  }
}

export async function setJobState(state: JobState): Promise<void> {
  const redis = await getRedis();
  await redis?.set(`job:${state.companyId}:${state.runId}`, JSON.stringify(state), { EX: 7_200 });
}

export async function deleteJobState(companyId: string, runId: string): Promise<void> {
  const redis = await getRedis();
  await redis?.del(`job:${companyId}:${runId}`);
}

// ─── Run statistics ───────────────────────────────────────────────────────────

const COST_PER_TOKEN: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
  "gpt-4o":      { input: 2.50 / 1_000_000, output: 10.00 / 1_000_000 },
};

export async function writeRunStats(params: {
  runId: string;
  companyId: string;
  asOfDate: string | null;
  metrics: MetricDef[];
  outputs: Record<string, Metric>;
  steps: TierStep[];
  latencyMs: number;
  cacheHit: boolean;
}): Promise<void> {
  const { runId, companyId, asOfDate, metrics, outputs, steps, latencyMs, cacheHit } = params;
  if (metrics.length === 0) return;

  let rows;

  if (cacheHit) {
    rows = metrics.map((m) => ({
      run_id: runId,
      company_id: companyId,
      metric_key: m.key,
      as_of_date: asOfDate,
      tier: null,
      model: null,
      confidence: null,
      extracted_value: outputs[m.key]?.value ?? null,
      source_snippet: outputs[m.key]?.source ?? null,
      latency_ms: latencyMs,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      cache_hit: true,
    }));
  } else {
    if (steps.length === 0) return;

    // The accepted step is the one that produced the final outputs.
    // Fall back to the last step if none were accepted (all failed).
    const winningStep = steps.find((s) => s.accepted) ?? steps[steps.length - 1];
    const costs = COST_PER_TOKEN[winningStep.model];
    const costUsd = costs
      ? costs.input * winningStep.inputTokens + costs.output * winningStep.outputTokens
      : null;

    rows = metrics.map((m) => ({
      run_id: runId,
      company_id: companyId,
      metric_key: m.key,
      as_of_date: asOfDate,
      tier: winningStep.tier,
      model: winningStep.model,
      confidence: winningStep.confidence,
      extracted_value: outputs[m.key]?.value ?? null,
      source_snippet: outputs[m.key]?.source ?? null,
      latency_ms: latencyMs,
      input_tokens: winningStep.inputTokens,
      output_tokens: winningStep.outputTokens,
      cost_usd: costUsd,
      cache_hit: false,
    }));
  }

  await supabase.from("run_stats").insert(rows);
}

// ─── Artifact persistence ─────────────────────────────────────────────────────

export interface PersistenceResult {
  artifactId: string | null;
  artifactRunId: string | null;
  entityId: string | null;
  metricsInserted: number;
}

/**
 * Normalises a raw LLM value string to a JS number.
 *
 * Handles Swedish formatting (comma = decimal, space = thousands)
 * and the integers the model produces after unit conversion.
 *
 *   "55,21"         → 55.21   (comma + 1-2 trailing digits = decimal)
 *   "42,0"          → 42.0
 *   "2,197"         → 2197    (comma + 3 trailing digits = thousands separator)
 *   "2,197,000,000" → 2197000000
 *   "2 197 000 000" → 2197000000
 */
function toNumeric(value: string | null): number | null {
  if (!value?.trim()) return null;
  // Remove whitespace and non-breaking spaces
  let s = value.trim().replace(/[\s\u00A0]/g, "");
  // Comma followed by exactly 1 or 2 digits at the end → Swedish decimal
  if (/,\d{1,2}$/.test(s)) {
    s = s.replace(/,(\d{1,2})$/, ".$1").replace(/,/g, "");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function resolveEntityId(companyName: string): Promise<string | null> {
  const { data } = await supabase
    .from("entities")
    .select("id")
    .ilike("name", companyName)
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

export async function persistRun(params: {
  company: CompanyInput;
  metricDefs: MetricDef[];
  outputs: Record<string, Metric>;
  reportUrl: string | null;
  steps: TierStep[];
  signal: ExtractionSignal;
  error: string | null;
  runContext?: RunContext;
}): Promise<PersistenceResult> {
  const { company, metricDefs, outputs, reportUrl, steps, signal, error, runContext } = params;
  const asOfDate = runContext?.asOfDate?.slice(0, 10) ?? null;

  const artifactId = await getOrCreateNewArtifact({
    key: "competitor_intel",
    name: "Competitor Intelligence",
    description: "Extract competitor intelligence metrics from company reports",
    runType: "metric",
  });

  const entityId = await resolveEntityId(company.name);

  const artifactRunId = await createNewArtifactRun({
    artifactId,
    runType: "metric",
    conversationId: runContext?.conversationId ?? null,
    agentId: runContext?.agentId ?? null,
    parameters: runContext?.parameters ?? { company: { id: company.id, name: company.name }, metricKeys: metricDefs.map((m) => m.key), as_of_date: asOfDate },
    definition: runContext?.definition ?? { metrics: metricDefs },
    output: { signal, report_url: reportUrl, steps, extraction_error: error, metrics: outputs },
  });

  let metricsInserted = 0;
  if (entityId && asOfDate) {
    const unitByKey = new Map(metricDefs.map((m) => [m.key, m.unit]));
    const rows = Object.entries(outputs).flatMap(([key, m]) => {
      const value = toNumeric(m.value);
      const unit = unitByKey.get(key);
      if (value === null || !unit) return [];
      return [{ entity_id: entityId, metric_key: key, value, unit, as_of_date: asOfDate, source_run_id: artifactRunId, source: m.source }];
    });

    if (rows.length > 0) {
      const { error: insertError } = await supabase
        .from("data")
        .upsert(rows, { onConflict: "entity_id,metric_key,as_of_date", ignoreDuplicates: true });
      if (!insertError) metricsInserted = rows.length;
    }
  }

  await updateNewArtifactRun({
    runId: artifactRunId,
    status: signal === "failed" ? "failed" : error ? "partial" : "success",
    output: { signal, report_url: reportUrl, steps, metrics: outputs, metrics_inserted: metricsInserted },
    entityId,
  });

  return { artifactId, artifactRunId, entityId, metricsInserted };
}
