import type { Logger } from "pino";

const CONFIDENCE_RANK: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function confidenceRank(c: string | null): number {
  return c !== null ? (CONFIDENCE_RANK[c] ?? 0) : 0;
}

export interface HarnessResult<T> {
  output: T | null;
  attempts: number;
  finalConfidence: string | null;
  succeeded: boolean;
}

export interface HarnessOptions<T> {
  /** Maximum retry attempts after the first. Default 2. */
  maxRetries?: number;
  /** Base backoff in ms (doubles each retry). Default 1000. */
  backoffMs?: number;
  /** Returns true if the output is good enough to stop retrying. */
  isSuccess: (output: T) => boolean;
  /** Maps output to a confidence label for best-result tracking. */
  getConfidence?: (output: T) => string | null;
  /** Appended as a note to the input on retry attempts. */
  retryNote?: string;
  /** Label used in log messages. */
  label?: string;
  /** Logger used for structured retry logs. */
  logger?: Logger;
  parentSpanId?: string;
}

/**
 * Wraps an async agent call with retries, exponential backoff, and best-result tracking.
 *
 * `fn` receives `null` on the first attempt and the `retryNote` on subsequent attempts.
 * The caller is responsible for incorporating the note into the agent input.
 *
 * Returns the best result seen across all attempts (highest confidence / first success),
 * not necessarily the last one.
 */
export async function runWithRetry<T>(
  fn: (note: string | null) => Promise<T | null>,
  options: HarnessOptions<T>
): Promise<HarnessResult<T>> {
  const {
    maxRetries = 2,
    backoffMs = 1000,
    isSuccess,
    getConfidence = () => null,
    retryNote = "Previous attempt returned low confidence. Focus on explicit labeled values only.",
    label = "harness",
    logger,
    parentSpanId,
  } = options;

  let best: T | null = null;
  let bestConfidence: string | null = null;
  let succeeded = false;
  const totalAttempts = maxRetries + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const note = attempt === 1 ? null : retryNote;

    try {
      const output = await fn(note);

      if (output !== null) {
        const confidence = getConfidence(output);
        const promoteToBest =
          best === null ||
          (isSuccess(output) && !isSuccess(best)) ||
          (isSuccess(output) === isSuccess(best) &&
            confidenceRank(confidence) > confidenceRank(bestConfidence));

        if (promoteToBest) {
          best = output;
          bestConfidence = confidence;
          succeeded = isSuccess(output);
        }
      }

      if (succeeded) {
        logger?.info(
          {
            event: "retry.succeeded",
            type: "decision",
            parent_span_id: parentSpanId,
            label,
            attempt,
            total_attempts: totalAttempts,
            confidence: bestConfidence,
          },
          "retry.succeeded"
        );
        return { output: best, attempts: attempt, finalConfidence: bestConfidence, succeeded: true };
      }

      if (attempt < totalAttempts) {
        const delay = backoffMs * Math.pow(2, attempt - 1);
        logger?.warn(
          {
            event: "retry.insufficient",
            type: "decision",
            parent_span_id: parentSpanId,
            label,
            attempt,
            total_attempts: totalAttempts,
            confidence: bestConfidence ?? "none",
            delay_ms: delay,
          },
          "retry.insufficient"
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    } catch (err) {
      logger?.error(
        {
          event: "retry.error",
          type: "decision",
          parent_span_id: parentSpanId,
          label,
          attempt,
          total_attempts: totalAttempts,
          error: String(err),
        },
        "retry.error"
      );
      if (attempt < totalAttempts) {
        const delay = backoffMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  logger?.warn(
    {
      event: "retry.exhausted",
      type: "decision",
      parent_span_id: parentSpanId,
      label,
      total_attempts: totalAttempts,
      confidence: bestConfidence ?? "none",
      succeeded,
    },
    "retry.exhausted"
  );
  return { output: best, attempts: totalAttempts, finalConfidence: bestConfidence, succeeded };
}
