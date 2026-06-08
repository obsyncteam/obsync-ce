import type { BlobStore } from "./blob-store.js";
import type { SyncRepository } from "../sync/repository.js";
import { withVaultMutationLock } from "../sync/vault-mutation-lock.js";

const DEFAULT_ORPHAN_MARK_GRACE_MS = 60 * 60 * 1000;
const DEFAULT_ORPHAN_DELETE_GRACE_MS = 60 * 60 * 1000;
const DEFAULT_ORPHAN_CLEANUP_LIMIT = 100;

export interface OrphanBlobCleanupResult {
  marked: number;
  scanned: number;
  deleted: number;
  failed: number;
}

export async function cleanupOrphanBlobs(input: {
  repository: SyncRepository;
  blobStore: BlobStore;
  markGraceMs?: number;
  deleteGraceMs?: number;
  limit?: number;
}): Promise<OrphanBlobCleanupResult> {
  const limit = input.limit ?? DEFAULT_ORPHAN_CLEANUP_LIMIT;
  const marked = await input.repository.markOrphanBlobRefs({
    olderThan: new Date(Date.now() - (input.markGraceMs ?? DEFAULT_ORPHAN_MARK_GRACE_MS)),
    limit,
  });
  const candidates = await input.repository.orphanBlobRefsReadyForDelete({
    orphanedBefore: new Date(Date.now() - (input.deleteGraceMs ?? DEFAULT_ORPHAN_DELETE_GRACE_MS)),
    limit,
  });

  let deleted = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      const removed = await withVaultMutationLock(candidate.vaultId, () => (
        input.repository.deleteOrphanBlobRef(
          candidate,
          () => input.blobStore.delete(candidate.storageKey),
        )
      ));
      if (removed) {
        deleted += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(
        `[obsync] orphan blob cleanup failed for ${candidate.vaultId}/${candidate.hash}`,
        error,
      );
    }
  }

  return {
    marked,
    scanned: candidates.length,
    deleted,
    failed,
  };
}
