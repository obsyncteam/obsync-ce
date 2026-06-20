import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerConfig } from "../config.js";

export async function servePublicWebRoute(
  _request: IncomingMessage,
  _response: ServerResponse,
  _path: string,
  config: ServerConfig,
): Promise<boolean> {
  if (!config.enableWebRoutes) return false;
  // Community Edition stays sync-only; website pages are served by a separate product.
  return false;
}
