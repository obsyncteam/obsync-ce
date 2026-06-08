import type { IncomingMessage } from "node:http";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { readWebSocketToken, timingSafeTokenEqual } from "../auth.js";
import type { ServerConfig } from "../config.js";
import { clientOperationSchema } from "../sync/operation-schema.js";
import type { SyncRepository } from "../sync/repository.js";
import type { OperationRecord } from "../sync/types.js";

interface ClientSession {
  socket: WebSocket;
  vaultId: string;
  deviceId: string;
}

export interface SyncSocketDependencies {
  config: ServerConfig;
  repository: SyncRepository;
}

export function createSyncSocketServer(deps: SyncSocketDependencies): WebSocketServer {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: deps.config.maxWsMessageBytes,
  });
  const sessions = new Set<ClientSession>();

  server.on("connection", async (socket, request) => {
    if (sessions.size >= deps.config.maxWsSessions) {
      socket.close(1013, "too many websocket sessions");
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const vaultId = url.searchParams.get("vaultId") ?? "default";
    const deviceId = url.searchParams.get("deviceId") ?? "anonymous";
    const deviceName = url.searchParams.get("deviceName") ?? deviceId;
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    const session: ClientSession = { socket, vaultId, deviceId };

    sessions.add(session);

    try {
      await deps.repository.ensureVault({ vaultId });
      await deps.repository.upsertDevice({ vaultId, deviceId, name: deviceName });

      send(socket, {
        type: "hello",
        vaultId,
        deviceId,
        cursor: Number.isInteger(cursor) && cursor >= 0 ? cursor : 0,
      });

      let backlogCursor = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
      while (socket.readyState === WebSocket.OPEN) {
        const page = await deps.repository.operationsPage({
          vaultId,
          cursor: backlogCursor,
        });

        for (const operation of page.operations) {
          send(socket, { type: "operation", operation });
        }

        if (!page.hasMore || page.nextCursor <= backlogCursor) break;
        backlogCursor = page.nextCursor;
      }
    } catch (error) {
      console.error("[obsync] websocket setup failed", error);
      socket.close(1011, "setup failed");
      sessions.delete(session);
      return;
    }

    socket.on("message", async (raw) => {
      try {
        const parsed = clientOperationSchema.parse(JSON.parse(raw.toString()));
        const operation = await deps.repository.appendOperation({
          vaultId,
          deviceId,
          opId: parsed.opId,
          operationType: parsed.operationType,
          fileId: parsed.fileId,
          path: parsed.path,
          payload: parsed.payload,
        });

        send(socket, { type: "ack", opId: parsed.opId, serverSeq: operation.serverSeq });
        broadcast(sessions, session, operation);
      } catch (error) {
        send(socket, {
          type: "error",
          message: error instanceof Error ? error.message : "invalid websocket message",
        });
      }
    });

    socket.on("close", () => {
      sessions.delete(session);
    });
  });

  return server;
}

export function shouldAcceptUpgrade(
  request: IncomingMessage,
  config: ServerConfig,
): boolean {
  const url = new URL(request.url ?? "/", "http://localhost");
  return url.pathname === "/sync" &&
    timingSafeTokenEqual(readWebSocketToken(request, url), config.authToken);
}

function broadcast(
  sessions: Set<ClientSession>,
  source: ClientSession,
  operation: OperationRecord,
): void {
  for (const session of sessions) {
    if (session === source) continue;
    if (session.vaultId !== source.vaultId) continue;
    if (session.socket.readyState !== WebSocket.OPEN) continue;

    send(session.socket, { type: "operation", operation });
  }
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}
