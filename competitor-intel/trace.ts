/**
 * Thin Langfuse wrapper. Every decision point in the pipeline logs through here.
 * All functions are no-ops when Langfuse is not configured.
 */
import { getLangfuse } from "../src/observability/langfuse";

export interface TraceCtx {
  traceId: string;
  parentId: string;
}

type SpanHandle = any;

export function span(ctx: TraceCtx | null | undefined, name: string, input?: unknown): SpanHandle {
  if (!ctx) return null;
  const lf = getLangfuse();
  if (!lf) return null;
  return lf.span({ traceId: ctx.traceId, parentObservationId: ctx.parentId, name, input }) ?? null;
}

export function endSpan(
  handle: SpanHandle,
  output?: unknown,
  opts?: { level?: "WARNING" | "ERROR"; metadata?: Record<string, unknown> }
): void {
  handle?.end({ output, metadata: opts?.metadata, ...(opts?.level ? { level: opts.level } : {}) });
}

export function generation(
  ctx: TraceCtx | null | undefined,
  name: string,
  model: string,
  prompt: string,
  output: unknown
): void {
  if (!ctx) return;
  const lf = getLangfuse();
  if (!lf) return;
  const gen = lf.generation({
    traceId: ctx.traceId,
    parentObservationId: ctx.parentId,
    name,
    model,
    input: { prompt_chars: prompt.length, prompt_preview: prompt.slice(0, 10_000) },
  });
  gen.end({ output });
}
