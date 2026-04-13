/** Strips null bytes and control characters that break PostgreSQL jsonb. */
export function sanitizeString(s: string | null): string | null {
  if (s === null) return null;
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

type RawMetric = { value: string | null; source: string | null };
type NormalizedMetric = { value: number | null; source: string | null };

/** Normalises a raw metric value from the LLM, handling Swedish number formats. */
export function normalizeMetric(raw?: RawMetric | null): NormalizedMetric {
  if (raw == null) return { value: null, source: null };

  const { value, source } = raw;
  if (value == null || value.trim() === "") return { value: null, source: null };

  const trimmed = value.trim();
  const parts = trimmed.split(/\s+/);

  if (parts.length > 1) {
    // If any part is a decimal, we have multiple distinct values — ambiguous
    const hasDecimal = parts.some((p) => /[.,]/.test(p));
    if (hasDecimal) return { value: null, source: null };

    // Swedish thousands format: all parts after the first must be exactly 3 digits
    const allAfterFirstAre3Digits = parts.slice(1).every((p) => /^\d{3}$/.test(p));
    if (!allAfterFirstAre3Digits) return { value: null, source: null };

    const num = parseInt(parts.join(""), 10);
    return isNaN(num) ? { value: null, source: null } : { value: num, source };
  }

  // Single token: treat comma as decimal separator (Swedish)
  const normalized = trimmed.replace(",", ".");
  const num = parseFloat(normalized);
  return isNaN(num) ? { value: null, source: null } : { value: num, source };
}

/** Like normalizeMetric, but applies ×1000 / ×1,000,000 multipliers when the source
 *  says "thousand/tusental" or "million", with a guard against double-scaling. */
export function normalizeSharesMetric(raw?: RawMetric | null): NormalizedMetric {
  const base = normalizeMetric(raw);
  if (base.value == null) return base;

  // Double-scale guard: already absolute units
  if (base.value >= 1_000_000) return base;

  const src = (base.source ?? "").toLowerCase();
  if (/tusental|thousand/.test(src)) return { ...base, value: base.value * 1_000 };
  if (/miljon|million/.test(src)) return { ...base, value: base.value * 1_000_000 };

  return base;
}

/** Parses a free-text report period hint into a structured year + optional type. */
export function parseReportHint(
  hint: string | null
): { year: number; type?: string } | null {
  if (!hint || hint.trim() === "") return null;

  const s = hint.trim().toLowerCase();
  const yearMatch = s.match(/\b(20\d{2}|19\d{2})\b/);
  if (!yearMatch) return null;

  const year = parseInt(yearMatch[1], 10);

  const qMatch = s.match(/\bq([1-4])\b/);
  if (qMatch) return { year, type: `Q${qMatch[1].toUpperCase()}` };

  if (s.includes("interim") || s.includes("delårs")) return { year, type: "interim" };
  if (s.includes("annual") || s.includes("årsrapport") || s.includes("årsredovisning")) {
    return { year, type: "annual" };
  }

  return { year };
}

/** Parses a date-range string into { start, end } ISO dates, or null if unparseable. */
export function parseReportRange(
  range: string | null
): { start: string; end: string } | null {
  if (!range || range.trim() === "") return null;

  const dates = range.match(/\d{4}-\d{2}-\d{2}/g);
  if (!dates || dates.length < 2) return null;

  return { start: dates[0], end: dates[1] };
}

interface EpraNrvInputs {
  equity: number | null;
  pref_equity: number | null;
  derivatives_balance_sheet: number | null;
  deferred_tax_balance_sheet: number | null;
  number_of_shares: number | null;
}

/** Derives EPRA NRV per share from balance-sheet components. */
export function deriveEpraNrv(inputs: EpraNrvInputs): number | null {
  const { equity, pref_equity, derivatives_balance_sheet, deferred_tax_balance_sheet, number_of_shares } = inputs;

  if (
    equity == null ||
    pref_equity == null ||
    derivatives_balance_sheet == null ||
    deferred_tax_balance_sheet == null ||
    number_of_shares == null
  ) {
    return null;
  }

  if (number_of_shares === 0) return null;

  const nrv =
    equity - Math.abs(pref_equity) + derivatives_balance_sheet + deferred_tax_balance_sheet;
  return nrv / number_of_shares;
}

/** Derives market value per sqm. Returns null for zero/negative area. */
export function deriveMarketValuePerSqm(
  marketValue: number | null,
  area: number | null
): number | null {
  if (marketValue == null || area == null) return null;
  if (area <= 0) return null;
  return marketValue / area;
}

/** Derives property value change % from valueChange and current marketValue.
 *  previousValue = marketValue - valueChange; returns null if previousValue is zero. */
export function derivePropertyValueChangePct(
  valueChange: number | null,
  marketValue: number | null
): number | null {
  if (valueChange == null || marketValue == null) return null;
  const previousValue = marketValue - valueChange;
  if (previousValue === 0) return null;
  return valueChange / previousValue;
}
