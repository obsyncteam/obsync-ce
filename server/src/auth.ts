import type { IncomingMessage } from "node:http";
import type { URL } from "node:url";
import { timingSafeEqual } from "node:crypto";

export function timingSafeTokenEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;

  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function readBearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization) return undefined;

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function readHttpToken(request: IncomingMessage, url: URL): string | undefined {
  return (
    readBearerToken(request) ??
    firstHeaderValue(request.headers["x-obsync-token"]) ??
    url.searchParams.get("token") ??
    undefined
  );
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
