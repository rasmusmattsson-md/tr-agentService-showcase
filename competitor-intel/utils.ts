/** Strips null bytes and control characters that break PostgreSQL jsonb. */
export function sanitizeString(s: string | null): string | null {
  if (s === null) return null;
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/** Normalises a URL to handle special characters in PDF links. */
export function normalizeUrl(url: string): string {
  return encodeURI(decodeURIComponent(url).normalize("NFC"));
}
