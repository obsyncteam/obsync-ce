import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const files = [
  "src/http/router.ts",
  "src/http/uploads.ts",
  "src/ws/sync-socket.ts",
  "src/sync/repository.ts",
  "src/sync/types.ts",
  "src/storage/postgres.ts",
];

const forbidden = [
  "/account",
  "/service",
  "/login",
  "/register",
  "/api/public/v1",
  "/mcp",
  "/s/",
  "billing",
  "subscription",
  "published_items",
  "api_keys",
  "mcp_clients",
];

let failed = false;

for (const file of files) {
  const path = join(root.pathname, file);
  const text = await readFile(path, "utf8");
  for (const marker of forbidden) {
    if (text.includes(marker)) {
      console.error(`[community-boundary] forbidden marker ${JSON.stringify(marker)} in ${file}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("[community-boundary] sync core has no paid route markers");
