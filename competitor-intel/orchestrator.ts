/**
 * Competitor Intel Orchestrator
 *
 * Four sequential phases:
 *   1. Cache      — return early if all metrics are fresh
 *   2. Discovery  — find the report PDF URL (with retry harness)
 *   3. Extraction — parseMetrics() → upsert cache
 *   4. Persist    — write run log + artifact record
 *
 * All decisions are traced to Langfuse. Redis tracks job status for the API layer.
 */
import { randomUUID } from "crypto";
import type { CompanyInput, MetricDef, OrchestratorResult, ExtractionSignal, TierStep, Metric, RunContext } from "./types";
import { parseMetrics } from "./parser/index";
import { getCachedMetrics, getDataCacheMetrics, upsertMetrics, writeRunLog, setJobState, deleteJobState, persistRun, writeRunStats } from "./db";
import { findReport } from "./reportsFinder";
import { runWithRetry } from "./harness";
import { getLangfuse, flushLangfuse } from "../src/observability/langfuse";
import { logger as baseLogger, withLogContext } from "../src/logging/logger";
import type { TraceCtx } from "./trace";
import * as trace from "./trace";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deriveSignal(steps: TierStep[], failed: boolean): ExtractionSignal {
  if (failed) return "failed";
  const tiers = steps.map((s) => s.tier);
  if (tiers.includes("tier_1_keyword") && tiers.includes("fallback_full_report")) return "partial_fallback";
  if (tiers.includes("fallback_full_report")) return "full_fallback";
  return "clean";
}

function inferExpectedPeriod(asOfDate: string): { type: string; allowed: string[]; disallowed: string[] } {
  const month = new Date(asOfDate).getMonth() + 1;
  const year = new Date(asOfDate).getFullYear();
  if (month <= 3)  return { type: `Q1 ${year}`, allowed: ["Q1", "januari-mars", "jan-mar", "interim"], disallowed: ["årsredovisning", "annual", "bokslutskommuniké"] };
  if (month <= 6)  return { type: `Q2 ${year}`, allowed: ["Q2", "januari-juni", "half-year", "delårsrapport"], disallowed: ["årsredovisning", "annual", "bokslutskommuniké"] };
  if (month <= 9)  return { type: `Q3 ${year}`, allowed: ["Q3", "januari-september", "nine-month", "delårsrapport"], disallowed: ["årsredovisning", "annual", "bokslutskommuniké"] };
  return { type: `Q4 ${year}`, allowed: ["Q4", "year-end", "bokslutskommuniké", "årsredovisning"], disallowed: [] };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export async function runOrchestrator(
  company: CompanyInput,
  metrics: MetricDef[],
  options?: { cacheMaxAgeHours?: number },
  runContext?: RunContext
): Promise<OrchestratorResult> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const log = withLogContext(baseLogger, { run_id: runId, company_id: company.id, workflow: "competitor_intel" });

  // Set up Langfuse trace
  const lf = getLangfuse();
  const traceId = runContext?.traceId ?? runId;
  const lfTrace = lf?.trace({
    id: traceId,
    name: "competitor_intel",
    input: { company: company.name, metric_keys: metrics.map((m) => m.key), as_of_date: runContext?.asOfDate ?? null },
    metadata: { company_id: company.id, run_id: runId },
    tags: ["competitor-intel"],
  }) ?? null;

  const rootSpan = lfTrace?.span({
    name: "ci.root",
    input: { company_id: company.id, run_id: runId },
    ...(runContext?.parentLangfuseObservationId ? { parentObservationId: runContext.parentLangfuseObservationId } : {}),
  }) ?? null;

  // TraceCtx threads through every parser call
  const ctx: TraceCtx | null = rootSpan ? { traceId, parentId: rootSpan.id } : null;

  await setJobState({ runId, companyId: company.id, status: "pending", step: "init", startedAt, updatedAt: new Date().toISOString() });
  await writeRunLog({ runId, companyId: company.id, status: "started" });

  try {
    // ── Phase 1: Cache ───────────────────────────────────────────────────────
    const cacheSpan = trace.span(ctx, "decision.cache", { metric_keys: metrics.map((m) => m.key) });
    const asOfDate = runContext?.asOfDate?.slice(0, 10) ?? null;

    let cached: Record<string, Metric> = await getCachedMetrics(company.id, metrics.map((m) => m.key), options?.cacheMaxAgeHours);
    if (asOfDate) {
      const dataCache = await getDataCacheMetrics(company.name, metrics.map((m) => m.key), asOfDate);
      cached = { ...cached, ...dataCache };
    }

    const missingMetrics = metrics.filter((m) => cached[m.key] == null);
    trace.endSpan(cacheSpan, { cached_keys: Object.keys(cached), missing_count: missingMetrics.length });

    if (missingMetrics.length === 0) {
      log.info({ event: "cache_hit.full" }, "cache_hit.full");
      await writeRunStats({ runId, companyId: company.id, asOfDate, metrics, outputs: cached, steps: [], latencyMs: Date.now() - new Date(startedAt).getTime(), cacheHit: true });
      return await finalize({ runId, company, metrics, outputs: cached, steps: [], signal: "clean", error: null, cachedMetricKeys: Object.keys(cached), reportUrl: null, ctx, lfTrace, rootSpan, startedAt, log, runContext });
    }

    await setJobState({ runId, companyId: company.id, status: "finding_report", step: "reports_finder", startedAt, updatedAt: new Date().toISOString() });

    // ── Phase 2: Report discovery ────────────────────────────────────────────
    const discoverySpan = trace.span(ctx, "phase.report_discovery", { company: company.name, as_of_date: asOfDate });
    const finderInput = { name: company.name, website_url: company.website_url, as_of_date: asOfDate ?? new Date().toISOString().slice(0, 10) };

    const discovery = await runWithRetry(
      (note) => findReport({ ...finderInput, ...(note ? { _note: note } : {}) }, { logger: log }),
      { isSuccess: (o) => !!o?.report_url, getConfidence: (o) => o?.report_url ? "high" : null, retryNote: "Previous attempt returned no valid report URL. Find the full report PDF.", label: `reportsFinder:${company.id}`, logger: log }
    );

    const reportUrl = discovery.output?.report_url ?? null;
    trace.endSpan(discoverySpan, { report_url: reportUrl, attempts: discovery.attempts }, reportUrl ? undefined : { level: "WARNING" });
    log.info({ event: "report_discovery.done", report_url: reportUrl, attempts: discovery.attempts }, "report_discovery.done");

    if (!reportUrl) {
      return await finalize({ runId, company, metrics, outputs: cached, steps: [], signal: "failed", error: "Report not found", cachedMetricKeys: Object.keys(cached), reportUrl: null, ctx, lfTrace, rootSpan, startedAt, log, runContext });
    }

    await setJobState({ runId, companyId: company.id, status: "parsing", step: "parser", startedAt, updatedAt: new Date().toISOString(), reportUrl });

    // ── Phase 3: Extraction ──────────────────────────────────────────────────
    const extractionSpan = trace.span(ctx, "phase.extraction", { report_url: reportUrl, metric_keys: missingMetrics.map((m) => m.key) });
    const extractionStart = Date.now();

    let freshOutputs: Record<string, Metric> = {};
    let steps: TierStep[] = [];
    let extractionError: string | null = null;

    try {
      const parseResult = await parseMetrics(missingMetrics, reportUrl, ctx);
      freshOutputs = parseResult.outputs;
      steps = parseResult.steps;

      trace.endSpan(extractionSpan, {
        extracted_keys: parseResult.diagnostics.extractedMetricKeys,
        route: parseResult.diagnostics.route,
        diagnostics: parseResult.diagnostics,
      });
    } catch (err) {
      extractionError = String(err);
      log.warn({ event: "extraction.failed", error: extractionError }, "extraction.failed");
      trace.endSpan(extractionSpan, { error: extractionError }, { level: "ERROR" });
    }

    await upsertMetrics(company.id, reportUrl, freshOutputs);
    await writeRunStats({ runId, companyId: company.id, asOfDate, metrics: missingMetrics, outputs: freshOutputs, steps, latencyMs: Date.now() - extractionStart, cacheHit: false });

    const allOutputs = { ...cached, ...freshOutputs };
    const signal = deriveSignal(steps, !!extractionError);

    // ── Phase 4: Persist ─────────────────────────────────────────────────────
    return await finalize({ runId, company, metrics, outputs: allOutputs, steps, signal, error: extractionError, cachedMetricKeys: Object.keys(cached), reportUrl, ctx, lfTrace, rootSpan, startedAt, log, runContext });

  } catch (err) {
    const error = String(err);
    log.error({ event: "orchestrator.crashed", error }, "orchestrator.crashed");
    await writeRunLog({ runId, companyId: company.id, status: "error", signal: "failed", error, finishedAt: new Date() });
    await setJobState({ runId, companyId: company.id, status: "failed", step: "crash", startedAt, updatedAt: new Date().toISOString(), error });
    lfTrace?.update({ output: { error }, metadata: { status: "error" } });
    rootSpan?.end({ output: { error }, metadata: { status: "error" } });
    await flushLangfuse();
    return { companyId: company.id, runId, reportUrl: null, metrics: {}, signal: "failed", steps: [], cachedMetricKeys: [], error, artifactRunId: null };
  }
}

// ─── Finalize ─────────────────────────────────────────────────────────────────

async function finalize(params: {
  runId: string;
  company: CompanyInput;
  metrics: MetricDef[];
  outputs: Record<string, Metric>;
  steps: TierStep[];
  signal: ExtractionSignal;
  error: string | null;
  cachedMetricKeys: string[];
  reportUrl: string | null;
  ctx: TraceCtx | null;
  lfTrace: any;
  rootSpan: any;
  startedAt: string;
  log: typeof baseLogger;
  runContext?: RunContext;
}): Promise<OrchestratorResult> {
  const { runId, company, metrics, outputs, steps, signal, error, cachedMetricKeys, reportUrl, lfTrace, rootSpan, log, runContext } = params;

  const persistSpan = trace.span(params.ctx, "phase.persist", { signal, report_url: reportUrl });
  let artifactRunId: string | null = null;

  try {
    const persistence = await persistRun({ company, metricDefs: metrics, outputs, reportUrl, steps, signal, error, runContext });
    artifactRunId = persistence.artifactRunId;
    trace.endSpan(persistSpan, { artifact_run_id: artifactRunId, metrics_inserted: persistence.metricsInserted });
  } catch (err) {
    log.error({ event: "persist.failed", error: String(err) }, "persist.failed");
    trace.endSpan(persistSpan, { error: String(err) }, { level: "ERROR" });
  }

  await writeRunLog({ runId, companyId: company.id, status: "done", signal, reportUrl, steps, error, finishedAt: new Date() });
  await deleteJobState(company.id, runId);

  lfTrace?.update({ output: { signal, report_url: reportUrl, extracted_count: Object.values(outputs).filter((m) => m.value != null).length }, metadata: { status: signal === "failed" ? "error" : "ok" } });
  rootSpan?.end({ output: { signal }, metadata: { status: "ok" } });

  log.info({ event: "orchestrator.done", signal, latency_ms: Date.now() - new Date(params.startedAt).getTime() }, "orchestrator.done");

  await flushLangfuse();

  return { companyId: company.id, runId, reportUrl, metrics: outputs, signal, steps, cachedMetricKeys, error, artifactRunId };
}
