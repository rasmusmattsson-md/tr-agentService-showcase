// import { normalizeUrl } from "../../../competitor-intel/utils/tools";

// /* ================= TYPES ================= */

// type PdfPageText = {
//   pageNumber: number;
//   text: string;
//   normalized: string;
// };

// type MetricConceptConfig = {
//   metric: string;
//   anchors: string[];
//   positiveSignals?: string[];
//   negativeSignals?: string[];
// };

// export type KeywordSearchHit = {
//   page: number;
//   keyword: string;
//   context: string;
// };

// export type MetricKeywordResult = {
//   metric: string;
//   matched: boolean;
//   matchedVariation: string | null;
//   hits: KeywordSearchHit[];
// };

// /* ================= METRIC CONFIG ================= */

// export const METRIC_CONCEPTS: MetricConceptConfig[] = [
//   {
//     metric: "epra_nrv",
//     anchors: [
//       "epra nrv",
//       "net reinstatement value",
//       "langsiktigt substansvärde"
//     ],
//     positiveSignals: [
//       "per aktie",
//       "kr",
//       "kr/stamaktie"
//     ],
//     negativeSignals: [
//       "förändring",
//       "%",
//       "bridge",
//       "reconciliation"
//     ]
//   },
//   {
//     metric: "epra_nav",
//     anchors: [
//       "epra nav",
//       "net asset value"
//     ],
//     positiveSignals: [
//       "kr"
//     ],
//     negativeSignals: [
//       "per aktie",
//       "förändring",
//       "%",
//       "bridge",
//       "reconciliation"
//     ]
//   },
//   {
//     metric: "number_of_shares",
//     anchors: [
//       "antal aktier",
//       "utestående aktier",
//       "shares outstanding"
//     ],
//     positiveSignals: [
//       "uppgick till",
//       "vid periodens slut",
//       "per balansdagen",
//       "registrerat aktiekapital"
//     ],
//     negativeSignals: [
//       "genomsnitt",
//       "vägt",
//       "resultat per aktie",
//       "största ägare",
//       "ägarstruktur",
//       "röster"
//     ]
//   }
// ];

// /* ================= CONFIG ================= */

// const WINDOW_RADIUS = 200;
// const MIN_SCORE_THRESHOLD = 12;

// /* ================= NORMALIZATION ================= */

// function normalizeText(text: string): string {
//   return text
//     .toLowerCase()
//     .normalize("NFD")
//     .replace(/[\u0300-\u036f]/g, "")
//     .replace(/\u00A0/g, " ")
//     .replace(/\s+/g, " ")
//     .trim();
// }

// /* ================= UTILS ================= */

// function hasFinancialNumber(text: string): boolean {
//   return /\d{1,3}(?:\s\d{3})*(?:,\d+)?/.test(text);
// }

// function buildAnchorRegex(anchor: string): RegExp {
//   const normalizedAnchor = normalizeText(anchor);

//   const escaped = normalizedAnchor
//     .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
//     .replace(/\s+/g, "\\s+");

//   return new RegExp(escaped, "gi");
// }

// function extractWindow(text: string, index: number, length: number): string {
//   const from = Math.max(0, index - WINDOW_RADIUS);
//   const to = Math.min(text.length, index + length + WINDOW_RADIUS);
//   return text.slice(from, to).replace(/\s+/g, " ").trim();
// }

// /* ================= SCORING ================= */

// function scoreWindow(
//   window: string,
//   config: MetricConceptConfig
// ): number {
//   const lower = normalizeText(window);
//   let score = 10; // anchor matched

//   for (const signal of config.positiveSignals ?? []) {
//     if (lower.includes(normalizeText(signal))) score += 5;
//   }

//   if (hasFinancialNumber(window)) score += 8;

//   if (lower.includes("kr")) score += 3;
//   if (lower.includes("mkr")) score += 3;
//   if (lower.includes("mdkr")) score += 3;

//   for (const signal of config.negativeSignals ?? []) {
//     if (lower.includes(normalizeText(signal))) score -= 8;
//   }

//   return score;
// }

// /* ================= PDF EXTRACTION ================= */

// async function extractPdfPages(pdfUrl: string): Promise<PdfPageText[]> {
//   const normalizedUrl = normalizeUrl(pdfUrl);
//   const response = await fetch(normalizedUrl);

//   if (!response.ok) {
//     throw new Error(`Failed to download PDF: ${response.status}`);
//   }

//   const bytes = new Uint8Array(await response.arrayBuffer());
//   const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
//   const pdf = await pdfjs.getDocument({ data: bytes } as any).promise;

//   const pages: PdfPageText[] = [];

//   for (let i = 1; i <= pdf.numPages; i++) {
//     const page = await pdf.getPage(i);
//     const content = await page.getTextContent();

//     const text = content.items
//       .map((item: any) => ("str" in item ? item.str : ""))
//       .join(" ")
//       .trim();

//     pages.push({
//       pageNumber: i,
//       text,
//       normalized: normalizeText(text)
//     });
//   }

//   return pages;
// }

// /* ================= FIND BEST CONCEPT HIT ================= */

// function findBestConceptHit(
//   pages: PdfPageText[],
//   config: MetricConceptConfig
// ): { hit: KeywordSearchHit; anchor: string } | null {

//   let best:
//     | { score: number; hit: KeywordSearchHit; anchor: string }
//     | null = null;

//   for (const anchor of config.anchors) {
//     const regex = buildAnchorRegex(anchor);

//     for (const page of pages) {
//       regex.lastIndex = 0; // critical fix

//       let match: RegExpExecArray | null;

//       while ((match = regex.exec(page.normalized)) !== null) {

//         const window = extractWindow(
//           page.text,
//           match.index,
//           match[0].length
//         );

//         const score = scoreWindow(window, config);

//         if (!best || score > best.score) {
//           best = {
//             score,
//             anchor,
//             hit: {
//               page: page.pageNumber,
//               keyword: anchor,
//               context: window
//             }
//           };
//         }
//       }
//     }
//   }

//   if (!best || best.score < MIN_SCORE_THRESHOLD) {
//     return null;
//   }

//   return {
//     hit: best.hit,
//     anchor: best.anchor
//   };
// }

// /* ================= MAIN ================= */

// export async function runPdfKeywordSearch(
//   pdfUrl: string
// ): Promise<{
//   pdf_url: string;
//   metrics: MetricKeywordResult[];
// }> {

//   const pages = await extractPdfPages(pdfUrl);

//   const metrics: MetricKeywordResult[] =
//     METRIC_CONCEPTS.map((config) => {

//       const best = findBestConceptHit(pages, config);

//       if (!best) {
//         return {
//           metric: config.metric,
//           matched: false,
//           matchedVariation: null,
//           hits: []
//         };
//       }

//       return {
//         metric: config.metric,
//         matched: true,
//         matchedVariation: best.anchor,
//         hits: [best.hit]
//       };
//     });

//   return {
//     pdf_url: pdfUrl,
//     metrics
//   };
// }




import { normalizeUrl } from "../../../competitor-intel-old/utils/tools";
import OpenAI from "openai";

/* ================= TYPES ================= */

type PdfPageText = {
  pageNumber: number;
  text: string;
  normalized: string;
};

type MetricConceptConfig = {
  metric: string;
  anchors: string[];
};

type ExtractedMetric = {
  unit: string | null;
  value: number | null;
  source: string | null;
};

export type FinalExtractionResult = {
  pdf_url: string;
  metrics: Record<string, ExtractedMetric>;
};

/* ================= METRIC CONFIG ================= */

export const METRIC_CONCEPTS: MetricConceptConfig[] = [
  {
    metric: "epra_nrv",
    anchors: [
      "epra nrv",
      "net reinstatement value",
      "langsiktigt substansvärde"
    ]
  },
  {
    metric: "epra_nav",
    anchors: [
      "epra nav",
      "net asset value"
    ]
  },
  {
    metric: "number_of_shares",
    anchors: [
      "antal aktier",
      "utestående aktier",
      "shares outstanding"
    ]
  }
];

/* ================= CONFIG ================= */

const WINDOW_LINES = 40;

/* ================= NORMALIZATION ================= */

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ================= PDF EXTRACTION ================= */

async function extractPdfPages(pdfUrl: string): Promise<PdfPageText[]> {
  const normalizedUrl = normalizeUrl(pdfUrl);
  const response = await fetch(normalizedUrl);

  if (!response.ok) {
    throw new Error(`Failed to download PDF: ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjs.getDocument({ data: bytes } as any).promise;

  const pages: PdfPageText[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    const text = content.items
      .map((item: any) => ("str" in item ? item.str : ""))
      .join(" ")
      .trim();

    pages.push({
      pageNumber: i,
      text,
      normalized: normalizeText(text)
    });
  }

  return pages;
}

/* ================= PAGE DETECTION ================= */

function detectMetricPages(
  pages: PdfPageText[]
): Map<number, string[]> {

  const pageMap = new Map<number, string[]>();

  for (const config of METRIC_CONCEPTS) {
    for (const page of pages) {

      for (const anchor of config.anchors) {
        const normalizedAnchor = normalizeText(anchor);

        if (page.normalized.includes(normalizedAnchor)) {

          if (!pageMap.has(page.pageNumber)) {
            pageMap.set(page.pageNumber, []);
          }

          const metrics = pageMap.get(page.pageNumber)!;
          if (!metrics.includes(config.metric)) {
            metrics.push(config.metric);
          }
        }
      }
    }
  }

  return pageMap;
}

/* ================= PAGE COMPRESSION ================= */

function compressPageForMetrics(
  page: PdfPageText,
  metrics: string[]
): string {

  const lines = page.text
    .split(/\n+/)
    .map(l => l.trim())
    .filter(Boolean);

  let anchorIndexes: number[] = [];

  for (const metric of metrics) {
    const config = METRIC_CONCEPTS.find(m => m.metric === metric)!;

    for (const anchor of config.anchors) {
      const normalizedAnchor = normalizeText(anchor);

      const index = lines.findIndex(l =>
        normalizeText(l).includes(normalizedAnchor)
      );

      if (index !== -1) anchorIndexes.push(index);
    }
  }

  if (!anchorIndexes.length) return page.text;

  const minIndex = Math.max(0, Math.min(...anchorIndexes) - WINDOW_LINES);
  const maxIndex = Math.min(lines.length, Math.max(...anchorIndexes) + WINDOW_LINES);

  return lines.slice(minIndex, maxIndex).join("\n");
}

/* ================= LLM EXTRACTION ================= */

async function extractWithLLM(
  pageNumber: number,
  compressedText: string,
  metrics: string[]
): Promise<Record<string, ExtractedMetric>> {

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const prompt = `
You are a financial data extraction engine.

Extract the following metrics from the page below.

Metrics:
${metrics.map(m => `- ${m}`).join("\n")}

Rules:
- Select the latest period (leftmost column if tabular).
- If value cannot be clearly identified, return null.
- Do not guess.
- Return strict JSON only.
- Preserve number formatting as numeric (e.g., 398.75).

Output format:

{
  "epra_nrv": { "unit": "...", "value": number|null, "source": string|null },
  "epra_nav": { "unit": "...", "value": number|null, "source": string|null },
  "number_of_shares": { "unit": "...", "value": number|null, "source": string|null }
}

Page number: ${pageNumber}

Page content:
<<<
${compressedText}
>>>
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: "You extract financial data deterministically." },
      { role: "user", content: prompt }
    ]
  });

  const content = response.choices[0].message.content;

  try {
    return JSON.parse(content ?? "{}");
  } catch {
    throw new Error("Invalid JSON returned from LLM");
  }
}

/* ================= MAIN ================= */

export async function runPdfKeywordSearch(
  pdfUrl: string
): Promise<FinalExtractionResult> {

  const pages = await extractPdfPages(pdfUrl);

  const pageMap = detectMetricPages(pages);

  const finalMetrics: Record<string, ExtractedMetric> = {
    epra_nrv: { unit: null, value: null, source: null },
    epra_nav: { unit: null, value: null, source: null },
    number_of_shares: { unit: null, value: null, source: null }
  };

  for (const [pageNumber, metrics] of pageMap.entries()) {

    const page = pages.find(p => p.pageNumber === pageNumber)!;

    const compressed = compressPageForMetrics(page, metrics);

    const extracted = await extractWithLLM(
      pageNumber,
      compressed,
      metrics
    );

    for (const metric of metrics) {
      if (extracted[metric]) {
        finalMetrics[metric] = extracted[metric];
      }
    }
  }

  return {
    pdf_url: pdfUrl,
    metrics: finalMetrics
  };
}
