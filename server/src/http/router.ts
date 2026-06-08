import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { URL } from "node:url";
import { z } from "zod";
import { readHttpToken, timingSafeTokenEqual } from "../auth.js";
import type { ServerConfig } from "../config.js";
import { blobStorageKey } from "../storage/blob-key.js";
import type { BlobStore } from "../storage/blob-store.js";
import type { BlobReadRange } from "../storage/blob-store.js";
import {
  FilePathConflictError,
  MissingFileContentError,
  OperationIdConflictError,
  OperationPreconditionFailedError,
  StorageQuotaExceededError,
  type SyncRepository,
} from "../sync/repository.js";
import { appendOperationSchema } from "../sync/operation-schema.js";
import { MARKDOWN_VERSION_MAX_BYTES } from "../sync/history-limits.js";
import { InvalidVaultPathError, validateSyncVaultPath } from "../sync/path-policy.js";
import { buildCompatibilityResult } from "../sync/protocol.js";
import { withVaultMutationLock } from "../sync/vault-mutation-lock.js";
import {
  allowedCorsOrigin,
  applyCorsHeaders,
  BodyTooLargeError,
  InvalidJsonError,
  readJsonBody,
  sendError,
  sendJson,
} from "./json.js";
import { handleUploadRoutes, isUploadHttpError } from "./uploads.js";
import {
  endStream,
  onceDrainOrError,
  throwTrackedStreamError,
  trackWriteStreamError,
} from "./stream-utils.js";

const ensureVaultSchema = z.object({
  vaultId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});
const HISTORY_CONTENT_MAX_BYTES = 2 * 1024 * 1024;

export interface RouterDependencies {
  config: ServerConfig;
  repository: SyncRepository;
  blobStore: BlobStore;
  dbReady: () => Promise<void>;
}

export function createRouter(deps: RouterDependencies) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const corsOrigin = allowedCorsOrigin(request, deps.config.allowedOrigins);
    if (corsOrigin) applyCorsHeaders(response, corsOrigin);

    try {
      if (request.method === "OPTIONS") {
        if (request.headers.origin && !corsOrigin) {
          sendError(response, 403, "origin is not allowed");
          return;
        }
        applyCorsHeaders(response);
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          service: "obsync-server",
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/ready") {
        await deps.dbReady();
        sendJson(response, 200, {
          ok: true,
          service: "obsync-server",
          storage: {
            metadata: "postgres",
            blobs: deps.blobStore.kind,
          },
        });
        return;
      }

      if (!isAuthorized(request, deps.config.authToken)) {
        sendError(response, 401, "unauthorized");
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/compat") {
        sendJson(response, 200, buildCompatibilityResult({
          clientVersion: url.searchParams.get("clientVersion") ?? undefined,
          protocolVersion: optionalIntegerSearchParam(url, "protocolVersion"),
        }));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/v1/vaults/ensure") {
        const body = ensureVaultSchema.parse(
          await readJsonBody(request, deps.config.maxJsonBodyBytes),
        );
        const vault = await deps.repository.ensureVault(body);
        sendJson(response, 200, { ok: true, vault });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/manifest") {
        const vaultId = requiredSearchParam(url, "vaultId");
        const limit = optionalPositiveIntegerSearchParam(url, "limit");

        if (limit) {
          const page = await deps.repository.manifestPage({
            vaultId,
            cursor: url.searchParams.get("cursor") ?? undefined,
            limit,
          });
          sendJson(response, 200, { ok: true, ...page });
          return;
        }

        const manifest = await deps.repository.manifest(vaultId);
        sendJson(response, 200, {
          ok: true,
          manifest,
          nextCursor: manifest.at(-1)?.path,
          hasMore: false,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/ops") {
        const vaultId = requiredSearchParam(url, "vaultId");
        const since = Number(url.searchParams.get("since") ?? "0");
        if (!Number.isInteger(since) || since < 0) {
          sendError(response, 400, "invalid since cursor");
          return;
        }

        const page = await deps.repository.operationsPage({
          vaultId,
          cursor: since,
          limit: optionalPositiveIntegerSearchParam(url, "limit"),
        });
        sendJson(response, 200, { ok: true, ...page });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/history") {
        const vaultId = requiredSearchParam(url, "vaultId");
        const path = validateSyncVaultPath(requiredSearchParam(url, "path"));
        const page = await deps.repository.historyPage({
          vaultId,
          path,
          cursor: optionalPositiveIntegerSearchParam(url, "cursor"),
          limit: optionalPositiveIntegerSearchParam(url, "limit"),
        });
        sendJson(response, 200, { ok: true, ...page });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/history/content") {
        const vaultId = requiredSearchParam(url, "vaultId");
        const path = validateSyncVaultPath(requiredSearchParam(url, "path"));
        const serverSeq = optionalPositiveIntegerSearchParam(url, "serverSeq");
        if (!serverSeq) {
          sendError(response, 400, "missing serverSeq");
          return;
        }

        const version = await deps.repository.historyVersion({ vaultId, path, serverSeq });
        const content = await historyVersionContent(version, deps.blobStore);
        if (!version || content === undefined) {
          sendError(response, 404, "history version content not found");
          return;
        }

        sendJson(response, 200, {
          ok: true,
          version: {
            serverSeq,
            path,
            hash: version.hash ?? version.entry.hash,
            content,
          },
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/storage/usage") {
        const vaultId = requiredSearchParam(url, "vaultId");
        const usage = await deps.repository.storageUsage(
          vaultId,
          deps.config.storageQuotaBytes,
        );
        sendJson(response, 200, { ok: true, usage });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/v1/ops") {
        const body = appendOperationSchema.parse(
          await readJsonBody(request, deps.config.maxJsonBodyBytes),
        );
        await deps.repository.ensureVault({ vaultId: body.vaultId });
        await deps.repository.upsertDevice({
          vaultId: body.vaultId,
          deviceId: body.deviceId,
        });
        const operation = await deps.repository.appendOperation(body);
        sendJson(response, 200, { ok: true, operation });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/v1/files/content") {
        const vaultId = requiredSearchParam(url, "vaultId");
        const deviceId = requiredSearchParam(url, "deviceId");
        const path = validateSyncVaultPath(requiredSearchParam(url, "path"));
        const kind = url.searchParams.get("kind") ?? "blob";
        if (kind !== "markdown" && kind !== "blob") {
          sendError(response, 400, "invalid file kind");
          return;
        }
        const mtimeMs = optionalIntegerSearchParam(url, "mtimeMs");
        const fileId = url.searchParams.get("fileId") ?? path;
        const expectedCurrentHash = url.searchParams.get("expectedCurrentHash") ?? undefined;
        const expectedCurrentSeq = optionalIntegerSearchParam(url, "expectedCurrentSeq");
        const contentType = request.headers["content-type"]?.toString();
        const temp = await writeRequestBodyToTemp(
          request,
          join(deps.config.dataDir, "tmp"),
          deps.config.maxDirectUploadBytes,
        );
        const hash = temp.hash;
        const storageKey = blobStorageKey(vaultId, hash);
        let reservationId: string | undefined;
        let shouldCancelReservation = true;

        try {
          const reservation = await deps.repository.reserveStorage({
            vaultId,
            fileId,
            path,
            sizeBytes: temp.sizeBytes,
            source: "sync",
            refId: hash,
            idempotencyKey: `direct:${deviceId}:${path}:${hash}:${Date.now()}`,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            quotaBytes: deps.config.storageQuotaBytes,
          });
          reservationId = reservation.id;

          const markdown = kind === "markdown" && temp.sizeBytes <= MARKDOWN_VERSION_MAX_BYTES
            ? await readFile(temp.filePath, "utf8")
            : undefined;

          const result = await withVaultMutationLock(vaultId, async () => {
            await deps.blobStore.putFile({
              key: storageKey,
              filePath: temp.filePath,
              contentType,
            });

            return deps.repository.commitUploadedFile({
              vaultId,
              deviceId,
              opId: `${deviceId}:direct-upload:${Date.now()}:${Math.random().toString(16).slice(2)}`,
              fileId,
              path,
              kind,
              hash,
              sizeBytes: temp.sizeBytes,
              storageKey,
              storageKind: deps.blobStore.kind,
              contentType,
              mtimeMs,
              content: markdown,
              expectedHash: expectedCurrentHash,
              expectedSeq: expectedCurrentSeq,
              quotaReservationId: reservationId,
            });
          });
          shouldCancelReservation = false;

          sendJson(response, 200, {
            ok: true,
            file: result.file,
            operation: result.operation,
          });
        } finally {
          if (shouldCancelReservation) {
            await deps.repository.cancelQuotaReservation(reservationId).catch((error) => {
              console.error("[obsync] failed to cancel direct upload reservation", error);
            });
          }
          await temp.cleanup();
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/files/content") {
        const vaultId = requiredSearchParam(url, "vaultId");
        const path = validateSyncVaultPath(requiredSearchParam(url, "path"));
        const file = await deps.repository.fileByPath(vaultId, path);

        if (!file) {
          sendError(response, 404, "file content not found");
          return;
        }

        if (!file.storageKey) {
          const inline = await deps.repository.inlineFileContentByPath(vaultId, path);
          if (!inline) {
            sendError(response, 404, "file content not found");
            return;
          }

          const body = Buffer.from(inline.content, "utf8");
          applyCorsHeaders(response);
          response.writeHead(200, {
            "content-type": inline.contentType,
            "content-length": body.byteLength,
            "x-obsync-kind": file.kind,
            "x-obsync-hash": inline.hash ?? file.hash ?? "",
            "x-obsync-size-bytes": String(inline.sizeBytes),
            "x-obsync-mtime-ms": String(inline.mtimeMs ?? ""),
          });
          response.end(body);
          return;
        }

        const totalSize = file.sizeBytes;
        const range = parseRangeHeader(request.headers.range, totalSize);
        if (range === "invalid") {
          applyCorsHeaders(response);
          response.writeHead(416, {
            "content-range": `bytes */${totalSize ?? "*"}`,
          });
          response.end();
          return;
        }

        const content = await deps.blobStore.getStream(file.storageKey, range);
        if (!content) {
          sendError(response, 404, "blob not found");
          return;
        }

        const responseSize = range
          ? range.end - range.start + 1
          : file.sizeBytes ?? content.contentLength ?? 0;
        applyCorsHeaders(response);
        response.writeHead(range ? 206 : 200, {
          "content-type": file.contentType ?? content.contentType ?? "application/octet-stream",
          "content-length": responseSize,
          "accept-ranges": "bytes",
          ...(range
            ? { "content-range": `bytes ${range.start}-${range.end}/${totalSize ?? content.totalSize ?? "*"}` }
            : {}),
          "x-obsync-kind": file.kind,
          "x-obsync-hash": file.hash ?? "",
          "x-obsync-size-bytes": String(file.sizeBytes ?? content.totalSize ?? content.contentLength ?? 0),
          "x-obsync-mtime-ms": String(file.mtimeMs ?? ""),
        });
        await pipeline(content.body, response);
        return;
      }

      if (await handleUploadRoutes(request, response, url, deps)) {
        return;
      }

      sendError(response, 404, "not found");
    } catch (error) {
      if (error instanceof z.ZodError) {
        sendJson(response, 400, {
          ok: false,
          error: "invalid request",
          details: error.issues,
        });
        return;
      }

      if (error instanceof HttpError) {
        sendError(response, error.statusCode, error.message);
        return;
      }

      if (
        error instanceof BodyTooLargeError ||
        error instanceof InvalidJsonError ||
        error instanceof InvalidVaultPathError
      ) {
        sendError(response, error.statusCode, error.message);
        return;
      }

      if (error instanceof OperationIdConflictError) {
        sendError(response, 409, error.message);
        return;
      }

      if (error instanceof OperationPreconditionFailedError) {
        sendError(response, 409, error.message);
        return;
      }

      if (error instanceof FilePathConflictError) {
        sendError(response, 409, error.message);
        return;
      }

      if (error instanceof MissingFileContentError) {
        sendError(response, 400, error.message);
        return;
      }

      if (error instanceof StorageQuotaExceededError) {
        sendJson(response, 413, {
          ok: false,
          error: "storage quota exceeded",
          vaultId: error.vaultId,
          quotaBytes: error.quotaBytes,
          logicalBytes: error.logicalBytes,
          reservedBytes: error.reservedBytes,
          requestedBytes: error.requestedBytes,
        });
        return;
      }

      if (isUploadHttpError(error)) {
        sendError(response, error.statusCode, error.message);
        return;
      }

      console.error("[obsync] request failed", error);
      if (response.headersSent) {
        response.end();
        return;
      }
      sendError(response, 500, "internal server error");
    }
  };
}

export function isAuthorized(
  request: IncomingMessage,
  expectedToken: string,
): boolean {
  return timingSafeTokenEqual(readHttpToken(request), expectedToken);
}

function requiredSearchParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new HttpError(400, `missing ${name}`);
  }
  return value;
}

function optionalIntegerSearchParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (!value) return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(400, `invalid ${name}`);
  }

  return parsed;
}

function optionalPositiveIntegerSearchParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (!value) return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, `invalid ${name}`);
  }

  return parsed;
}

function parseRangeHeader(
  header: string | undefined,
  totalSize: number | undefined,
): BlobReadRange | undefined | "invalid" {
  if (!header) return undefined;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return "invalid";

  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) return "invalid";

  if (!totalSize && !startText) return "invalid";

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0 || !totalSize) {
      return "invalid";
    }
    const start = Math.max(totalSize - suffixLength, 0);
    return { start, end: totalSize - 1 };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : undefined;
  if (!Number.isInteger(start) || start < 0) return "invalid";
  if (requestedEnd !== undefined && (!Number.isInteger(requestedEnd) || requestedEnd < start)) {
    return "invalid";
  }

  const end = totalSize
    ? Math.min(requestedEnd ?? totalSize - 1, totalSize - 1)
    : requestedEnd;

  if (end === undefined) return "invalid";
  if (totalSize !== undefined && start >= totalSize) return "invalid";

  return { start, end };
}

async function historyVersionContent(
  version: Awaited<ReturnType<SyncRepository["historyVersion"]>>,
  blobStore: BlobStore,
): Promise<string | undefined> {
  if (!version) return undefined;
  if (version.content !== undefined) return version.content;
  if (!version.storageKey) return undefined;
  if (version.sizeBytes !== undefined && version.sizeBytes > HISTORY_CONTENT_MAX_BYTES) {
    throw new HttpError(413, "history version is too large");
  }

  const content = await blobStore.getStream(version.storageKey);
  if (!content) return undefined;
  const body = await readStreamToBuffer(content.body, HISTORY_CONTENT_MAX_BYTES);
  return body.toString("utf8");
}

async function readStreamToBuffer(
  stream: Readable,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    sizeBytes += buffer.byteLength;
    if (sizeBytes > maxBytes) {
      throw new HttpError(413, "history version is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

interface TempRequestBody {
  filePath: string;
  hash: string;
  sizeBytes: number;
  cleanup: () => Promise<void>;
}

async function writeRequestBodyToTemp(
  request: IncomingMessage,
  tempDir: string,
  maxBytes: number,
): Promise<TempRequestBody> {
  const contentLength = request.headers["content-length"];
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new HttpError(413, "request body too large");
  }

  await mkdir(tempDir, { recursive: true });

  const hash = createHash("sha256");
  const filePath = join(
    tempDir,
    `${Date.now()}-${Math.random().toString(16).slice(2)}.upload`,
  );
  const output = createWriteStream(filePath, { flags: "wx" });
  const trackedError = trackWriteStreamError(output);
  let sizeBytes = 0;

  try {
    for await (const chunk of request) {
      throwTrackedStreamError(trackedError);
      const buffer = Buffer.from(chunk);
      sizeBytes += buffer.byteLength;
      if (sizeBytes > maxBytes) {
        throw new HttpError(413, "request body too large");
      }
      hash.update(buffer);

      if (!output.write(buffer)) {
        await onceDrainOrError(output);
      }
    }

    throwTrackedStreamError(trackedError);
    await endStream(output);

    return {
      filePath,
      hash: `sha256:${hash.digest("hex")}`,
      sizeBytes,
      cleanup: () => rm(filePath, { force: true }),
    };
  } catch (error) {
    output.destroy();
    await rm(filePath, { force: true });
    throw error;
  }
}
