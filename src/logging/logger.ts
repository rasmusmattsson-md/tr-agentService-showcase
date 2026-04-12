import { randomUUID } from "crypto";
import pino, { type Logger } from "pino";
import { Writable } from "stream";

type LogContext = {
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  conversation_id?: string | null;
  session_id?: string | null;
  agent_id?: string | null;
  run_id?: string | null;
  company_id?: string | null;
  route?: string;
  method?: string;
  workflow?: string;
};

/** Optional remote log shipping (works alongside LangFuse tracing). */
class BetterStackStream extends Writable {
  constructor(
    private readonly endpoint: string,
    private readonly token: string
  ) {
    super();
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ) {
    const payload = chunk.toString("utf8").trim();
    if (!payload) {
      callback();
      return;
    }

    void fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: payload,
    }).catch(() => {});

    callback();
  }
}

class NullStream extends Writable {
  _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ) {
    callback();
  }
}

function createStreams() {
  const streams: Array<{ stream: NodeJS.WritableStream }> = [
    { stream: new NullStream() },
  ];

  const endpoint = process.env.BETTER_STACK_ENDPOINT;
  const token = process.env.BETTER_STACK_SOURCE_TOKEN;

  if (endpoint && token) {
    streams.push({ stream: new BetterStackStream(endpoint, token) });
  }

  return streams;
}

export function createServiceLogger(service: string): Logger {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      base: {
        service,
        env: process.env.NODE_ENV ?? "development",
      },
      messageKey: "message",
      redact: {
        paths: [
          "authorization",
          "headers.authorization",
          "req.headers.authorization",
          "*.authorization",
          "*.apiKey",
          "*.api_key",
          "*.token",
          "*.openai_api_key",
        ],
        censor: "[Redacted]",
      },
    },
    pino.multistream(createStreams())
  );
}

export function withLogContext(logger: Logger, context: LogContext): Logger {
  const bindings = Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined && value !== null)
  );
  return logger.child(bindings);
}

export function createSpanId(prefix = "span"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function createSpanLogger(
  logger: Logger,
  params: LogContext & {
    span_id?: string;
    parent_span_id?: string;
    type: string;
    span_name: string;
  }
): { logger: Logger; spanId: string } {
  const spanId = params.span_id ?? createSpanId(params.span_name.replace(/[^a-z0-9]+/gi, "_"));
  const spanLogger = withLogContext(logger, {
    ...params,
    span_id: spanId,
  });

  spanLogger.info(
    {
      event: "span.started",
      type: params.type,
      span_name: params.span_name,
    },
    "span.started"
  );

  return { logger: spanLogger, spanId };
}

export const logger = createServiceLogger("agent-service");
