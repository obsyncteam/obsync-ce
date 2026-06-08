import http from "node:http";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createRouter } from "./http/router.js";
import { cleanupUploadSessions } from "./http/uploads.js";
import type { BlobStore } from "./storage/blob-store.js";
import { cleanupOrphanBlobs } from "./storage/blob-cleanup.js";
import { FilesystemBlobStore } from "./storage/filesystem-blob-store.js";
import { createPostgresPool, assertPostgresReady, runMigrations } from "./storage/postgres.js";
import { S3BlobStore } from "./storage/s3-blob-store.js";
import { SyncRepository } from "./sync/repository.js";
import { createSyncSocketServer, shouldAcceptUpgrade } from "./ws/sync-socket.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPostgresPool(config.database);

  await assertPostgresReady(pool);
  await runMigrations(pool);

  const repository = new SyncRepository(pool);
  const blobStore = config.blobStore === "s3"
    ? new S3BlobStore(config.s3!)
    : new FilesystemBlobStore(join(config.dataDir, "blobs"));

  const router = createRouter({
    config,
    repository,
    blobStore,
    dbReady: () => assertPostgresReady(pool),
  });

  const httpServer = http.createServer(router);
  httpServer.maxConnections = config.maxHttpConnections;
  httpServer.requestTimeout = 60_000;
  httpServer.headersTimeout = 65_000;
  httpServer.keepAliveTimeout = 5_000;

  const wsServer = createSyncSocketServer({ config, repository });
  const storageCleanupTimer = setInterval(() => {
    void cleanupStorage({
      dataDir: config.dataDir,
      repository,
      blobStore,
    })
      .catch((error) => console.error("[obsync] storage cleanup failed", error));
  }, 60 * 60 * 1000);
  storageCleanupTimer.unref();

  void cleanupStorage({
    dataDir: config.dataDir,
    repository,
    blobStore,
  }).catch((error) => console.error("[obsync] storage cleanup failed", error));

  httpServer.on("upgrade", (request, socket, head) => {
    if (!shouldAcceptUpgrade(request, config)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (websocket) => {
      wsServer.emit("connection", websocket, request);
    });
  });

  httpServer.listen(config.port, config.host, () => {
    console.log(
      `[obsync] server listening on ${config.host}:${config.port} ` +
        `(metadata=postgres blobs=${blobStore.kind})`,
    );
  });

  process.on("SIGTERM", () => {
    clearInterval(storageCleanupTimer);
    httpServer.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  });
}

async function cleanupStorage(input: {
  dataDir: string;
  repository: SyncRepository;
  blobStore: BlobStore;
}): Promise<void> {
  const uploadCleanup = await cleanupUploadSessions(input.dataDir, input.repository);
  if (uploadCleanup.deleted > 0) {
    console.log(
      `[obsync] cleaned ${uploadCleanup.deleted}/${uploadCleanup.scanned} upload sessions`,
    );
  }

  const orphanCleanup = await cleanupOrphanBlobs({
    repository: input.repository,
    blobStore: input.blobStore,
  });
  if (orphanCleanup.marked > 0 || orphanCleanup.deleted > 0 || orphanCleanup.failed > 0) {
    console.log(
      `[obsync] orphan blob cleanup marked=${orphanCleanup.marked} ` +
        `deleted=${orphanCleanup.deleted}/${orphanCleanup.scanned} ` +
        `failed=${orphanCleanup.failed}`,
    );
  }
}

main().catch((error) => {
  console.error("[obsync] server failed to start", error);
  process.exit(1);
});
