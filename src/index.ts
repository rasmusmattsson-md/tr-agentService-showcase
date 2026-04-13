import express from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import type { Logger } from "pino";
import { runOrchestrator } from "../competitor-intel/orchestrator";
import { METRICS } from "../competitor-intel/metrics";
import type { MetricDef } from "../competitor-intel/types";
import { createSpanId, createSpanLogger, logger } from "./logging/logger";

declare global {
  namespace Express {
    interface Request {
      traceId?: string;
      parentSpanId?: string;
      spanId?: string;
      log: Logger;
    }
  }
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const incomingTraceId = req.header("x-trace-id");
  const incomingParentSpanId = req.header("x-parent-span-id");
  const traceId =
    typeof incomingTraceId === "string" && incomingTraceId.trim() !== ""
      ? incomingTraceId
      : randomUUID();
  const startedAt = Date.now();

  req.traceId = traceId;
  req.parentSpanId =
    typeof incomingParentSpanId === "string" && incomingParentSpanId.trim() !== ""
      ? incomingParentSpanId
      : undefined;
  req.spanId = createSpanId("request");
  const requestSpan = createSpanLogger(logger, {
    trace_id: traceId,
    span_id: req.spanId,
    parent_span_id: req.parentSpanId,
    route: req.path,
    method: req.method,
    type: "http_request",
    span_name: `${req.method} ${req.path}`,
  });
  req.log = requestSpan.logger;

  res.setHeader("x-trace-id", traceId);
  res.setHeader("x-span-id", req.spanId);

  req.log.info({ event: "request.received" }, "request.received");
  res.on("finish", () => {
    req.log.info(
      {
        event: "request.completed",
        type: "http_request",
        span_name: `${req.method} ${req.path}`,
        status: res.statusCode >= 400 ? "error" : "ok",
        status_code: res.statusCode,
        duration_ms: Date.now() - startedAt,
      },
      "request.completed"
    );
  });

  next();
});

const companySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  website_url: z.string().url(),
});

const runBodySchema = z.object({
  company: companySchema,
  metrics: z.array(z.object({ key: z.string().min(1) })).optional(),
  options: z
    .object({
      modelOverride: z.string().optional(),
      cacheMaxAgeHours: z.number().optional(),
    })
    .optional(),
  run_context: z
    .object({
      conversationId: z.string().nullable().optional(),
      agentId: z.string().nullable().optional(),
      asOfDate: z.string().nullable().optional(),
      traceId: z.string().nullable().optional(),
      parentSpanId: z.string().nullable().optional(),
      parentLangfuseObservationId: z.string().nullable().optional(),
    })
    .optional(),
});

/**
 * Competitor-intel pipeline — called by brain (`/v1/invoke`) or for direct integration tests.
 * Headers: `x-trace-id`, optional `x-langfuse-parent-observation-id` (brain delegate span).
 */
app.post("/internal/competitor-intel/run", async (req, res) => {
  const parsed = runBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.flatten(),
    });
  }

  const { company, metrics, options, run_context } = parsed.data;
  const headerLfParent = req.header("x-langfuse-parent-observation-id") ?? undefined;

  let resolvedMetrics: MetricDef[];
  if (Array.isArray(metrics) && metrics.length > 0) {
    resolvedMetrics = [];
    for (const m of metrics) {
      const def = METRICS[m.key];
      if (!def) {
        return res.status(400).json({ error: `Unknown metric key: ${m.key}` });
      }
      resolvedMetrics.push(def);
    }
  } else {
    resolvedMetrics = Object.values(METRICS);
  }

  if (!company?.id || !company?.name || !company?.website_url) {
    return res.status(400).json({ error: "Missing required company fields: id, name, website_url" });
  }

  try {
    const result = await runOrchestrator(company, resolvedMetrics, options, {
      conversationId: run_context?.conversationId ?? null,
      agentId: run_context?.agentId ?? null,
      asOfDate: run_context?.asOfDate ?? null,
      traceId: run_context?.traceId ?? req.traceId ?? null,
      parentSpanId: run_context?.parentSpanId ?? req.spanId ?? null,
      parentLangfuseObservationId:
        run_context?.parentLangfuseObservationId ?? headerLfParent ?? null,
    });
    return res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ event: "competitor_intel.run.failed", error: msg }, "competitor_intel.run.failed");
    return res.status(500).json({ error: msg });
  }
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "agent-service" });
});

const PORT = Number(process.env.PORT ?? 3002);
app.listen(PORT, "0.0.0.0", () => {
  logger.info({ event: "service.started", port: PORT }, "service.started");
});
