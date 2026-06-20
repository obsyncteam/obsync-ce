import type { IncomingMessage, ServerResponse } from "node:http";

export class BodyTooLargeError extends Error {
  readonly statusCode = 413;

  constructor(message = "request body too large") {
    super(message);
    this.name = "BodyTooLargeError";
  }
}

export class InvalidJsonError extends Error {
  readonly statusCode = 400;

  constructor(message = "invalid json") {
    super(message);
    this.name = "InvalidJsonError";
  }
}

export function allowedCorsOrigin(
  request: IncomingMessage,
  allowedOrigins: readonly string[],
): string | undefined {
  const origin = request.headers.origin;
  if (!origin || Array.isArray(origin)) return undefined;
  return allowedOrigins.includes(origin) ? origin : undefined;
}

export function applyCorsHeaders(response: ServerResponse, origin?: string): void {
  if (origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
  }
  response.setHeader("access-control-allow-methods", "GET,HEAD,POST,PUT,DELETE,OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    [
      "authorization",
      "content-type",
      "x-obsync-token",
      "x-obsync-client-version",
      "x-obsync-protocol-version",
      "x-obsync-chunk-sha256",
      "range",
    ].join(","),
  );
  response.setHeader(
    "access-control-expose-headers",
    "x-obsync-kind,x-obsync-hash,x-obsync-size-bytes,x-obsync-mtime-ms,content-length,content-type,content-range,accept-ranges",
  );
}

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes = 1024 * 1024,
): Promise<unknown> {
  assertContentLengthWithinLimit(request, maxBytes);
  const chunks: Buffer[] = [];
  let sizeBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    sizeBytes += buffer.byteLength;
    if (sizeBytes > maxBytes) {
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidJsonError();
  }
}

export async function readRawBody(
  request: IncomingMessage,
  maxBytes = 1024 * 1024,
): Promise<Buffer> {
  assertContentLengthWithinLimit(request, maxBytes);
  const chunks: Buffer[] = [];
  let sizeBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    sizeBytes += buffer.byteLength;
    if (sizeBytes > maxBytes) {
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function assertContentLengthWithinLimit(
  request: IncomingMessage,
  maxBytes: number,
): void {
  const contentLength = request.headers["content-length"];
  if (!contentLength) return;
  const parsed = Number(Array.isArray(contentLength) ? contentLength[0] : contentLength);
  if (Number.isFinite(parsed) && parsed > maxBytes) {
    throw new BodyTooLargeError();
  }
}

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  applyCorsHeaders(response);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function sendError(
  response: ServerResponse,
  statusCode: number,
  message: string,
): void {
  sendJson(response, statusCode, {
    ok: false,
    error: message,
  });
}
