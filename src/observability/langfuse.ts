import { Langfuse } from "langfuse";

let client: Langfuse | null | undefined;

export function getLangfuse(): Langfuse | null {
  if (client === undefined) {
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    if (!publicKey?.trim() || !secretKey?.trim()) {
      client = null;
    } else {
      client = new Langfuse({
        publicKey: publicKey.trim(),
        secretKey: secretKey.trim(),
        ...(process.env.LANGFUSE_BASE_URL?.trim()
          ? { baseUrl: process.env.LANGFUSE_BASE_URL.trim() }
          : {}),
      });
    }
  }
  return client;
}

export async function flushLangfuse(): Promise<void> {
  await getLangfuse()?.flushAsync();
}
