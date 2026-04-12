import type { PageText, PdfData } from "../types";
import { normalizeUrl } from "../utils";

// Patterns that identify definition / glossary pages in Swedish and English reports
const DEFINITION_PAGE_PATTERNS = [
  /\bdefinitioner\b/i,
  /\bdefinitions\b/i,
  /\bordlista\b/i,
  /\bnyckeltal\s+och\s+definitioner\b/i,
  /\bbegreppslista\b/i,
  /\balternativa\s+nyckeltal\b/i,
  /\bicke-ifrs\b/i,
  /\bordförklaringar?\b/i,
  /\bbegreppsdefinitioner?\b/i,
  /\bnyckeltalsdefinitioner?\b/i,
];

function buildPageText(items: any[]): string {
  const positioned = items
    .filter((item) => typeof item.str === "string" && item.str.trim())
    .map((item) => ({
      text: item.str.trim(),
      x: Number(item.transform?.[4] ?? 0),
      y: Number(item.transform?.[5] ?? 0),
    }));

  if (positioned.length === 0) return "";

  // Group into rows by y-position (4pt tolerance), sort rows top→bottom, words left→right
  const rows = new Map<number, Array<{ text: string; x: number }>>();
  for (const item of positioned) {
    const yKey = Math.round(item.y / 4) * 4;
    const row = rows.get(yKey) ?? [];
    row.push(item);
    rows.set(yKey, row);
  }

  return [...rows.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, row]) => row.sort((a, b) => a.x - b.x).map((i) => i.text).join(" ").trim())
    .filter(Boolean)
    .join("\n");
}

export async function loadPdf(reportUrl: string): Promise<PdfData> {
  const res = await fetch(normalizeUrl(reportUrl));
  if (!res.ok) throw new Error(`Failed to fetch PDF: ${res.status} ${reportUrl}`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("pdf") && !reportUrl.toLowerCase().includes(".pdf")) {
    throw new Error(`URL did not resolve to a PDF (content-type: ${contentType})`);
  }

  const buffer = await res.arrayBuffer();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjs.getDocument({ data: buffer.slice(0) } as any).promise;

  const pages: PageText[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push({ pageNumber: i, text: buildPageText(content.items as any[]) });
  }

  return { bytes: new Uint8Array(buffer), pages, pdf };
}

export function findDefinitionPages(pages: PageText[]): number[] {
  return pages
    .filter((p) => DEFINITION_PAGE_PATTERNS.some((rx) => rx.test(p.text)))
    .map((p) => p.pageNumber);
}

export async function renderPages(pdf: any, pageNumbers: number[]): Promise<string[]> {
  const { createCanvas } = await import("@napi-rs/canvas");
  return Promise.all(pageNumbers.map(async (n) => {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1.2 });
    const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
    await page.render({ canvasContext: canvas.getContext("2d") as any, viewport }).promise;
    return canvas.toBuffer("image/png").toString("base64");
  }));
}
