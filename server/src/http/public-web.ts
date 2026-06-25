import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerConfig } from "../config.js";

export async function servePublicWebRoute(
  _request: IncomingMessage,
  _response: ServerResponse,
  _path: string,
  config: ServerConfig,
): Promise<boolean> {
  if (!config.enableWebRoutes) return false;
  // Public web pages live in commercial/web. The Community sync server must stay sync-only.
  return false;
}
