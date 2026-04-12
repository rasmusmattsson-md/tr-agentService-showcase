import { describe, it, expect, vi } from "vitest";
import { runWithRetry } from "../../competitor-intel/harness";

// All tests use backoffMs: 0 so setTimeout(r, 0) resolves immediately — no fake timers needed.

type Result = { confidence: string | null; value: number };

const isSuccess = (r: Result) => r.confidence === "high" || r.confidence === "medium";
const getConfidence = (r: Result) => r.confidence;

// ─────────────────────────────────────────────
// Success on first attempt
// ─────────────────────────────────────────────
describe("runWithRetry — first attempt success", () => {
  it("returns result without retrying when first attempt succeeds", async () => {
    const fn = vi.fn().mockResolvedValue({ confidence: "high", value: 42 });

    const result = await runWithRetry(fn, { isSuccess, getConfidence, backoffMs: 0 });

    expect(result.succeeded).toBe(true);
    expect(result.output?.value).toBe(42);
    expect(result.attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(null); // no retry note on first attempt
  });
});

// ─────────────────────────────────────────────
// Retry behavior
// ─────────────────────────────────────────────
describe("runWithRetry — retry behavior", () => {
  it("retries on low confidence and passes retry note on subsequent attempts", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ confidence: "low", value: 1 })   // attempt 1
      .mockResolvedValueOnce({ confidence: "high", value: 2 });  // attempt 2

    const result = await runWithRetry(fn, {
      isSuccess,
      getConfidence,
      backoffMs: 0,
      retryNote: "Try harder",
    });

    expect(result.succeeded).toBe(true);
    expect(result.output?.value).toBe(2);
    expect(result.attempts).toBe(2);
    expect(fn).toHaveBeenNthCalledWith(1, null);
    expect(fn).toHaveBeenNthCalledWith(2, "Try harder");
  });

  it("exhausts all attempts and returns best result when none succeed", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ confidence: "low", value: 1 })
      .mockResolvedValueOnce({ confidence: "low", value: 2 })
      .mockResolvedValueOnce({ confidence: "low", value: 3 });

    const result = await runWithRetry(fn, {
      isSuccess,
      getConfidence,
      backoffMs: 0,
      maxRetries: 2,
    });

    expect(result.succeeded).toBe(false);
    expect(result.attempts).toBe(3); // 1 initial + 2 retries
  });

  it("respects maxRetries=0 (no retries, just one attempt)", async () => {
    const fn = vi.fn().mockResolvedValue({ confidence: "low", value: 1 });

    const result = await runWithRetry(fn, { isSuccess, getConfidence, maxRetries: 0, backoffMs: 0 });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(1);
  });
});

// ─────────────────────────────────────────────
// Best-result tracking
// ─────────────────────────────────────────────
describe("runWithRetry — best result tracking", () => {
  it("stops immediately when first attempt meets success threshold", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ confidence: "medium", value: 10 }) // attempt 1 — success
      .mockResolvedValueOnce({ confidence: "low", value: 99 });   // attempt 2 — should never run

    const result = await runWithRetry(fn, {
      isSuccess,
      getConfidence,
      backoffMs: 0,
      maxRetries: 2,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output?.value).toBe(10);
    expect(result.finalConfidence).toBe("medium");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("promotes to higher confidence result on retry", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ confidence: "low", value: 1 })     // attempt 1
      .mockResolvedValueOnce({ confidence: null, value: 2 })      // attempt 2 — worse
      .mockResolvedValueOnce({ confidence: "medium", value: 3 }); // attempt 3 — better

    const result = await runWithRetry(fn, {
      isSuccess,
      getConfidence,
      backoffMs: 0,
      maxRetries: 2,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output?.value).toBe(3);
    expect(result.finalConfidence).toBe("medium");
  });
});

// ─────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────
describe("runWithRetry — error handling", () => {
  it("catches thrown errors and continues to next attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error"))         // attempt 1 throws
      .mockResolvedValueOnce({ confidence: "high", value: 7 });  // attempt 2 succeeds

    const result = await runWithRetry(fn, { isSuccess, getConfidence, backoffMs: 0 });

    expect(result.succeeded).toBe(true);
    expect(result.output?.value).toBe(7);
    expect(result.attempts).toBe(2);
  });

  it("returns null output if all attempts throw", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));

    const result = await runWithRetry(fn, { isSuccess, getConfidence, backoffMs: 0, maxRetries: 1 });

    expect(result.succeeded).toBe(false);
    expect(result.output).toBeNull();
    expect(result.attempts).toBe(2); // 1 initial + 1 retry
  });

  it("returns null output if fn always returns null", async () => {
    const fn = vi.fn().mockResolvedValue(null);

    const result = await runWithRetry(fn, { isSuccess, getConfidence, backoffMs: 0, maxRetries: 1 });

    expect(result.output).toBeNull();
    expect(result.succeeded).toBe(false);
  });
});
