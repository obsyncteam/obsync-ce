import { randomUUID } from "node:crypto";
import type { PostgresClient, PostgresPool } from "../storage/postgres.js";
import type {
  AppendOperationInput,
  CommitUploadedFileInput,
  CommitUploadedFileResult,
  FileEntry,
  HistoryEntry,
  HistoryPage,
  HistoryVersion,
  InlineFileContent,
  ManifestPage,
  OperationPage,
  OperationRecord,
  OrphanBlobRef,
  ReserveStorageInput,
  StorageReservationRecord,
  StorageUsageRecord,
  UploadChunkRecord,
  UploadSessionRecord,
  UpdateFileStorageInput,
  UpsertBlobRefInput,
  VaultRecord,
} from "./types.js";

const MARKDOWN_VERSIONS_RETENTION_LIMIT = 10;
type DatabaseClient = PostgresClient;
type QueryClient = Pick<PostgresPool, "query">;

interface StoredContentRef {
  storageKey: string;
  storageKind: string;
  contentType?: string;
  sizeBytes?: number;
}

export class SyncRepository {
  private readonly defaultPageLimit = 1000;
  private readonly maxPageLimit = 5000;

  constructor(private readonly pool: PostgresPool) {}

  async ensureVault(input: { vaultId?: string; name?: string }): Promise<VaultRecord> {
    const id = input.vaultId ?? randomUUID();
    const name = input.name ?? "default";

    const result = await this.pool.query(
      `
        insert into vaults(id, name)
        values ($1, $2)
        on conflict (id) do update
          set name = excluded.name,
              updated_at = now()
        returning id, name
      `,
      [id, name],
    );

    return mapVault(result.rows[0]);
  }

  async upsertDevice(input: {
    vaultId: string;
    deviceId: string;
    name?: string;
  }): Promise<void> {
    await this.upsertDeviceInClient(this.pool, input);
  }

  async appendOperation(input: AppendOperationInput): Promise<OperationRecord> {
    return this.withTransaction(async (client) => {
      await this.acquireVaultWriteLock(client, input.vaultId);
      return this.appendOperationInClient(client, input);
    });
  }

  async operationsPage(input: {
    vaultId: string;
    cursor: number;
    limit?: number;
  }): Promise<OperationPage> {
    const limit = this.normalizeLimit(input.limit);
    const result = await this.pool.query(
      `
        select *
        from operations
        where vault_id = $1 and server_seq > $2
        order by server_seq asc
        limit $3
      `,
      [input.vaultId, input.cursor, limit + 1],
    );

    const rows = result.rows.slice(0, limit);
    const operations = rows.map(mapOperation);
    const nextCursor = operations.at(-1)?.serverSeq ?? input.cursor;

    return {
      operations,
      nextCursor,
      hasMore: result.rows.length > limit,
    };
  }

  async historyPage(input: {
    vaultId: string;
    path: string;
    cursor?: number;
    limit?: number;
  }): Promise<HistoryPage> {
    const limit = this.normalizeLimit(input.limit);
    const result = await this.pool.query(
      `
        with current_file as (
          select file_id
          from files
          where vault_id = $1
            and path = $2
          limit 1
        )
        select
          o.*,
          br.storage_key as history_storage_key,
          br.content_type as history_content_type,
          mv.markdown as history_markdown
        from operations o
        left join blob_refs br
          on br.vault_id = o.vault_id
         and br.hash = o.payload ->> 'hash'
         and br.deleted_at is null
        left join markdown_versions mv
          on mv.vault_id = o.vault_id
         and mv.file_id = coalesce(o.file_id, o.path)
         and mv.server_seq = o.server_seq
        where o.vault_id = $1
          and ($3::bigint is null or o.server_seq < $3)
          and (
            o.path = $2
            or o.payload ->> 'newPath' = $2
            or o.file_id = (select file_id from current_file)
          )
        order by o.server_seq desc
        limit $4
      `,
      [input.vaultId, input.path, input.cursor ?? null, limit + 1],
    );

    const rows = result.rows.slice(0, limit);
    const entries = rows.map(mapHistoryEntry);
    const currentFile = await this.fileByPath(input.vaultId, input.path);

    return {
      file: {
        vaultId: input.vaultId,
        path: input.path,
        fileId: currentFile?.fileId,
      },
      entries,
      nextCursor: entries.at(-1)?.serverSeq,
      hasMore: result.rows.length > limit,
    };
  }

  async historyVersion(input: {
    vaultId: string;
    path: string;
    serverSeq: number;
  }): Promise<HistoryVersion | undefined> {
    const result = await this.pool.query(
      `
        with current_file as (
          select file_id
          from files
          where vault_id = $1
            and path = $2
          limit 1
        )
        select
          o.*,
          br.storage_key as history_storage_key,
          br.content_type as history_content_type,
          br.size_bytes as history_size_bytes,
          mv.markdown as history_markdown
        from operations o
        left join blob_refs br
          on br.vault_id = o.vault_id
         and br.hash = o.payload ->> 'hash'
         and br.deleted_at is null
        left join markdown_versions mv
          on mv.vault_id = o.vault_id
         and mv.file_id = coalesce(o.file_id, o.path)
         and mv.server_seq = o.server_seq
        where o.vault_id = $1
          and o.server_seq = $3
          and (
            o.path = $2
            or o.payload ->> 'newPath' = $2
            or o.file_id = (select file_id from current_file)
          )
        limit 1
      `,
      [input.vaultId, input.path, input.serverSeq],
    );
    const row = result.rows[0];
    if (!row) return undefined;

    const entry = mapHistoryEntry(row);
    const historyMarkdown = optionalString(row.history_markdown);
    if (historyMarkdown !== undefined) {
      return {
        entry: {
          ...entry,
          contentAvailable: true,
        },
        content: historyMarkdown,
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: Buffer.byteLength(historyMarkdown, "utf8"),
        hash: entry.hash,
      };
    }
    if (entry.operationType !== "file_upsert" || entry.kind !== "markdown") {
      return { entry };
    }

    const inlineContent = stringPayload(entryPayload(row), "content");
    if (inlineContent !== undefined) {
      return {
        entry: {
          ...entry,
          contentAvailable: true,
        },
        content: inlineContent,
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: Buffer.byteLength(inlineContent, "utf8"),
        hash: entry.hash,
      };
    }

    const storageKey = optionalString(row.history_storage_key);
    if (!storageKey) return { entry };

    return {
      entry,
      storageKey,
      contentType: optionalString(row.history_content_type),
      sizeBytes: optionalNumber(row.history_size_bytes) ?? entry.sizeBytes,
      hash: entry.hash,
    };
  }

  async manifest(vaultId: string): Promise<FileEntry[]> {
    const result = await this.pool.query(
      `
        select *
        from files
        where vault_id = $1
          and deleted_at is null
        order by path asc
      `,
      [vaultId],
    );

    return result.rows.map(mapFileEntry);
  }

  async manifestPage(input: {
    vaultId: string;
    cursor?: string;
    limit?: number;
  }): Promise<ManifestPage> {
    const limit = this.normalizeLimit(input.limit);
    const result = await this.pool.query(
      `
        select *
        from files
        where vault_id = $1
          and deleted_at is null
          and ($2::text is null or path > $2)
        order by path asc
        limit $3
      `,
      [input.vaultId, input.cursor ?? null, limit + 1],
    );

    const rows = result.rows.slice(0, limit);
    const manifest = rows.map(mapFileEntry);

    return {
      manifest,
      nextCursor: manifest.at(-1)?.path,
      hasMore: result.rows.length > limit,
    };
  }

  async fileByPath(vaultId: string, path: string): Promise<FileEntry | undefined> {
    const result = await this.pool.query(
      `
        select *
        from files
        where vault_id = $1 and path = $2 and deleted_at is null
        limit 1
      `,
      [vaultId, path],
    );

    const row = result.rows[0];
    return row ? mapFileEntry(row) : undefined;
  }

  async inlineFileContentByPath(
    vaultId: string,
    path: string,
  ): Promise<InlineFileContent | undefined> {
    const result = await this.pool.query(
      `
        select
          f.kind,
          f.hash,
          f.size_bytes,
          f.mtime_ms,
          f.content_type,
          o.payload
        from files f
        left join operations o
          on o.vault_id = f.vault_id
         and o.server_seq = f.updated_seq
        where f.vault_id = $1
          and f.path = $2
          and f.deleted_at is null
        limit 1
      `,
      [vaultId, path],
    );

    const row = result.rows[0];
    if (!row || String(row.kind) !== "markdown") return undefined;

    const payload = jsonObject(row.payload);
    const content = stringPayload(payload, "content");
    if (content === undefined) return undefined;

    return {
      content,
      contentType: optionalString(row.content_type) ??
        stringPayload(payload, "contentType") ??
        "text/markdown; charset=utf-8",
      sizeBytes: optionalNumber(row.size_bytes) ?? Buffer.byteLength(content, "utf8"),
      hash: optionalString(row.hash) ?? stringPayload(payload, "hash"),
      mtimeMs: optionalNumber(row.mtime_ms) ?? numberPayload(payload, "mtimeMs"),
    };
  }

  async commitUploadedFile(input: CommitUploadedFileInput): Promise<CommitUploadedFileResult> {
    return this.withTransaction(async (client) => {
      await this.acquireVaultWriteLock(client, input.vaultId);
      await this.ensureVaultInClient(client, input.vaultId);
      await this.upsertDeviceInClient(client, {
        vaultId: input.vaultId,
        deviceId: input.deviceId,
        name: input.deviceId,
      });
      await this.upsertBlobRefInClient(client, input);

      const operation = await this.appendOperationInClient(client, {
        vaultId: input.vaultId,
        opId: input.opId,
        deviceId: input.deviceId,
        operationType: "file_upsert",
        fileId: input.fileId,
        path: input.path,
        payload: {
          kind: input.kind,
          hash: input.hash,
          sizeBytes: input.sizeBytes,
          mtimeMs: input.mtimeMs,
          contentType: input.contentType,
          contentStored: true,
          ...(input.content !== undefined ? { content: input.content } : {}),
          expectedHash: input.expectedHash,
          expectedSeq: input.expectedSeq,
        },
      });

      const file = {
        vaultId: input.vaultId,
        fileId: input.fileId,
        path: input.path,
        kind: input.kind,
        hash: input.hash,
        sizeBytes: input.sizeBytes,
        mtimeMs: input.mtimeMs,
        storageKey: input.storageKey,
        storageKind: input.storageKind,
        contentType: input.contentType,
      };

      await this.updateFileStorageInClient(client, {
        ...file,
        updatedSeq: operation.serverSeq,
      });
      await this.closeQuotaReservationInClient(
        client,
        input.quotaReservationId,
        "finalized",
        "quota_finalized",
        operation.opId,
      );

      const finalized = input.uploadId ? { file, operation } : undefined;
      if (input.uploadId && finalized) {
        await this.finalizeUploadSessionInClient(client, input.uploadId, finalized);
      }

      return { file, operation, finalized };
    });
  }

  async blobRefExists(vaultId: string, hash: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        select 1
        from blob_refs
        where vault_id = $1
          and hash = $2
          and deleted_at is null
        limit 1
      `,
      [vaultId, hash],
    );

    return Boolean(result.rows[0]);
  }

  async createUploadSession(input: {
    uploadId: string;
    vaultId: string;
    deviceId: string;
    fileId: string;
    path: string;
    kind: string;
    sizeBytes: number;
    mtimeMs?: number;
    contentType?: string;
    expectedHash?: string;
    expectedCurrentHash?: string;
    expectedCurrentSeq?: number;
    chunkSize: number;
    quotaReservationId?: string;
    expiresAt: Date;
  }): Promise<UploadSessionRecord> {
    return this.withTransaction(async (client) => {
      await this.ensureVaultInClient(client, input.vaultId);

      const result = await client.query(
        `
          insert into upload_sessions(
            id,
            vault_id,
            device_id,
            file_id,
            path,
            kind,
            size_bytes,
            mtime_ms,
            content_type,
            expected_hash,
            expected_current_hash,
            expected_current_seq,
            chunk_size_bytes,
            quota_reservation_id,
            status,
            expires_at
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, 'uploading', $15
          )
          returning *
        `,
        [
          input.uploadId,
          input.vaultId,
          input.deviceId,
          input.fileId,
          input.path,
          input.kind,
          input.sizeBytes,
          input.mtimeMs,
          input.contentType,
          input.expectedHash,
          input.expectedCurrentHash,
          input.expectedCurrentSeq,
          input.chunkSize,
          input.quotaReservationId,
          input.expiresAt,
        ],
      );

      return mapUploadSession(result.rows[0]);
    });
  }

  async uploadSession(uploadId: string): Promise<UploadSessionRecord | undefined> {
    const result = await this.pool.query(
      `
        select *
        from upload_sessions
        where id = $1
        limit 1
      `,
      [uploadId],
    );

    return result.rows[0] ? mapUploadSession(result.rows[0]) : undefined;
  }

  async markUploadSessionFinalizing(uploadId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        update upload_sessions
        set status = 'finalizing',
            updated_at = now()
        where id = $1
          and status = 'uploading'
        returning id
      `,
      [uploadId],
    );
    return Boolean(result.rowCount && result.rowCount > 0);
  }

  async markUploadSessionUploading(uploadId: string): Promise<void> {
    await this.pool.query(
      `
        update upload_sessions
        set status = 'uploading',
            updated_at = now()
        where id = $1
          and status = 'finalizing'
      `,
      [uploadId],
    );
  }

  async deleteUploadSession(uploadId: string): Promise<void> {
    await this.pool.query(
      `
        delete from upload_sessions
        where id = $1
      `,
      [uploadId],
    );
  }

  async upsertUploadChunk(input: {
    uploadId: string;
    index: number;
    sizeBytes: number;
    hash: string;
  }): Promise<UploadChunkRecord> {
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `
          insert into upload_chunks(
            upload_session_id,
            chunk_index,
            size_bytes,
            hash
          )
          values ($1, $2, $3, $4)
          on conflict(upload_session_id, chunk_index) do update
            set size_bytes = excluded.size_bytes,
                hash = excluded.hash,
                received_at = now()
          returning *
        `,
        [input.uploadId, input.index, input.sizeBytes, input.hash],
      );

      await client.query(
        `
          update upload_sessions
          set updated_at = now()
          where id = $1
        `,
        [input.uploadId],
      );

      return mapUploadChunk(result.rows[0]);
    });
  }

  async uploadChunks(uploadId: string): Promise<UploadChunkRecord[]> {
    const result = await this.pool.query(
      `
        select *
        from upload_chunks
        where upload_session_id = $1
        order by chunk_index asc
      `,
      [uploadId],
    );

    return result.rows.map(mapUploadChunk);
  }

  async staleUploadSessions(input: {
    activeBefore: Date;
    finalizedBefore: Date;
    limit: number;
  }): Promise<UploadSessionRecord[]> {
    const result = await this.pool.query(
      `
        select *
        from upload_sessions
        where (
            status = 'finalized'
            and updated_at <= $2
          )
          or (
            status <> 'finalized'
            and (expires_at <= now() or updated_at <= $1)
          )
        order by updated_at asc
        limit $3
      `,
      [input.activeBefore, input.finalizedBefore, input.limit],
    );

    return result.rows.map(mapUploadSession);
  }

  async storageUsage(vaultId: string, quotaBytes?: number): Promise<StorageUsageRecord> {
    const result = await this.pool.query(
      `
        with logical_usage as (
          select coalesce(sum(coalesce(size_bytes, 0)), 0)::bigint as bytes
          from files
          where vault_id = $1
            and deleted_at is null
            and kind <> 'folder'
        ),
        physical_usage as (
          select coalesce(sum(br.size_bytes), 0)::bigint as bytes
          from blob_refs br
          where br.vault_id = $1
            and br.deleted_at is null
            and exists (
              select 1
              from files f
              where f.vault_id = br.vault_id
                and f.hash = br.hash
                and f.deleted_at is null
            )
        ),
        reserved_usage as (
          select coalesce(sum(bytes_reserved), 0)::bigint as bytes
          from quota_reservations
          where vault_id = $1
            and status = 'active'
            and expires_at > now()
        ),
        quota as (
          select quota_bytes
          from vault_quotas
          where vault_id = $1
          limit 1
        )
        select
          (select bytes from logical_usage) as logical_bytes,
          (select bytes from physical_usage) as physical_bytes,
          (select bytes from reserved_usage) as reserved_bytes,
          (select quota_bytes from quota) as quota_bytes
      `,
      [vaultId],
    );

    const row = result.rows[0] ?? {};
    return {
      vaultId,
      logicalBytes: optionalNumber(row.logical_bytes) ?? 0,
      physicalBytes: optionalNumber(row.physical_bytes) ?? 0,
      reservedBytes: optionalNumber(row.reserved_bytes) ?? 0,
      quotaBytes: quotaBytes ?? optionalNumber(row.quota_bytes),
    };
  }

  async reserveStorage(input: ReserveStorageInput): Promise<StorageReservationRecord> {
    return this.withTransaction(async (client) => {
      await this.ensureVaultInClient(client, input.vaultId);
      await this.acquireVaultWriteLock(client, input.vaultId);

      const existing = await client.query(
        `
          select *
          from quota_reservations
          where vault_id = $1 and idempotency_key = $2
          limit 1
        `,
        [input.vaultId, input.idempotencyKey],
      );

      if (existing.rows[0]) {
        return mapStorageReservation(existing.rows[0]);
      }

      const quotaBytes = await this.vaultQuotaInClient(
        client,
        input.vaultId,
        input.quotaBytes,
      );
      const previousSize = await this.activeFileSizeInClient(
        client,
        input.vaultId,
        input.fileId,
        input.path,
      );
      const bytesReserved = Math.max(0, input.sizeBytes - previousSize);
      const usage = await this.storageUsageInClient(client, input.vaultId);

      if (
        quotaBytes !== undefined &&
        usage.logicalBytes + usage.reservedBytes + bytesReserved > quotaBytes
      ) {
        throw new StorageQuotaExceededError({
          vaultId: input.vaultId,
          quotaBytes,
          logicalBytes: usage.logicalBytes,
          reservedBytes: usage.reservedBytes,
          requestedBytes: bytesReserved,
        });
      }

      const result = await client.query(
        `
          insert into quota_reservations(
            id,
            vault_id,
            source,
            bytes_reserved,
            status,
            expires_at,
            idempotency_key,
            ref_id
          )
          values ($1, $2, $3, $4, 'active', $5, $6, $7)
          returning *
        `,
        [
          randomUUID(),
          input.vaultId,
          input.source,
          bytesReserved,
          input.expiresAt,
          input.idempotencyKey,
          input.refId,
        ],
      );

      if (bytesReserved > 0) {
        await this.insertLedgerEntry(client, {
          vaultId: input.vaultId,
          source: input.source,
          deltaReservedBytes: bytesReserved,
          reason: "quota_reserved",
          refId: input.refId,
        });
      }

      return mapStorageReservation(result.rows[0]);
    });
  }

  async cancelQuotaReservation(
    reservationId: string | undefined,
    reason: "cancelled" | "expired" = "cancelled",
  ): Promise<void> {
    if (!reservationId) return;
    await this.closeQuotaReservation(
      reservationId,
      reason,
      reason === "expired" ? "quota_expired" : "quota_cancelled",
    );
  }

  async markOrphanBlobRefs(input: {
    olderThan: Date;
    limit: number;
  }): Promise<number> {
    const result = await this.pool.query(
      `
        with candidates as (
          select br.vault_id, br.hash
          from blob_refs br
          where br.orphaned_at is null
            and br.deleted_at is null
            and br.created_at <= $1
            and not exists (
              select 1
              from files f
              where f.vault_id = br.vault_id
                and f.hash = br.hash
                and f.deleted_at is null
            )
          order by br.created_at asc
          limit $2
        )
        update blob_refs br
        set orphaned_at = now()
        from candidates c
        where br.vault_id = c.vault_id
          and br.hash = c.hash
        returning br.vault_id
      `,
      [input.olderThan, input.limit],
    );

    return result.rowCount ?? 0;
  }

  async orphanBlobRefsReadyForDelete(input: {
    orphanedBefore: Date;
    limit: number;
  }): Promise<OrphanBlobRef[]> {
    const result = await this.pool.query(
      `
        select vault_id, hash, size_bytes, storage_key, storage_kind
        from blob_refs br
        where br.orphaned_at is not null
          and br.orphaned_at <= $1
          and br.deleted_at is null
          and not exists (
            select 1
            from files f
            where f.vault_id = br.vault_id
              and f.hash = br.hash
              and f.deleted_at is null
          )
        order by br.orphaned_at asc
        limit $2
      `,
      [input.orphanedBefore, input.limit],
    );

    return result.rows.map(mapOrphanBlobRef);
  }

  async deleteOrphanBlobRef(
    input: OrphanBlobRef,
    deleteBlob: () => Promise<void>,
  ): Promise<boolean> {
    return this.withTransaction(async (client) => {
      await this.acquireVaultWriteLock(client, input.vaultId);

      const result = await client.query(
        `
          select br.size_bytes
          from blob_refs br
          where br.vault_id = $1
            and br.hash = $2
            and br.storage_key = $3
            and br.orphaned_at is not null
            and br.deleted_at is null
            and not exists (
              select 1
              from files f
              where f.vault_id = br.vault_id
                and f.hash = br.hash
                and f.deleted_at is null
            )
          for update
        `,
        [input.vaultId, input.hash, input.storageKey],
      );

      if (!result.rowCount) return false;

      await deleteBlob();

      await client.query(
        `
          delete from blob_refs
          where vault_id = $1
            and hash = $2
            and storage_key = $3
            and orphaned_at is not null
            and deleted_at is null
        `,
        [input.vaultId, input.hash, input.storageKey],
      );

      const deletedSize = optionalNumber(result.rows[0]?.size_bytes) ?? input.sizeBytes;
      if (deletedSize > 0) {
        await this.insertLedgerEntry(client, {
          vaultId: input.vaultId,
          source: "storage",
          deltaPhysicalBytes: -deletedSize,
          reason: "orphan_blob_deleted",
          refId: input.hash,
        });
      }

      return true;
    });
  }

  private async applyOperationToManifest(
    client: Pick<PostgresPool, "query">,
    operation: OperationRecord,
  ): Promise<void> {
    const payload = operation.payload;
    const fileId = operation.fileId ?? stringPayload(payload, "fileId") ?? operation.path;
    const path = operation.path ?? stringPayload(payload, "path");

    if (!fileId || !path) return;
    await this.assertOperationPreconditions(client, operation, fileId, path);

    if (operation.operationType === "delete") {
      const target = await this.activeFileRecordInClient(
        client,
        operation.vaultId,
        fileId,
        path,
      );
      const tombstoneFileId = target?.fileId ?? fileId;
      const tombstonePath = target?.path ?? path;
      const previousSize = target?.sizeBytes ?? 0;

      if (target) {
        await client.query(
          `
            update files
            set deleted_at = now(),
                updated_seq = $3,
                updated_at = now()
            where vault_id = $1 and file_id = $2
          `,
          [operation.vaultId, target.fileId, operation.serverSeq],
        );
      }

      await client.query(
        `
          insert into tombstones(
            vault_id,
            file_id,
            path,
            op_id,
            device_id,
            deleted_seq
          )
          values ($1, $2, $3, $4, $5, $6)
          on conflict (vault_id, file_id) do update
            set path = excluded.path,
                op_id = excluded.op_id,
                device_id = excluded.device_id,
                deleted_seq = excluded.deleted_seq,
                deleted_at = now()
        `,
        [
          operation.vaultId,
          tombstoneFileId,
          tombstonePath,
          operation.opId,
          operation.deviceId,
          operation.serverSeq,
        ],
      );

      if (previousSize > 0) {
        await this.insertLedgerEntry(client, {
          vaultId: operation.vaultId,
          source: "sync",
          deltaLogicalBytes: -previousSize,
          reason: "file_deleted",
          refId: operation.opId,
        });
      }
      return;
    }

    if (operation.operationType === "rename") {
      const target = await this.activeFileRecordInClient(
        client,
        operation.vaultId,
        fileId,
        path,
      );
      if (!target) return;

      const newPath = stringPayload(payload, "newPath") ?? path;
      await this.assertActivePathAvailableInClient(
        client,
        operation.vaultId,
        target.fileId,
        newPath,
      );
      await client.query(
        `
          update files
          set path = $3,
              kind = coalesce($4, kind),
              updated_seq = $5,
              updated_at = now()
          where vault_id = $1 and file_id = $2
        `,
        [
          operation.vaultId,
          target.fileId,
          newPath,
          stringPayload(payload, "kind"),
          operation.serverSeq,
        ],
      );
      return;
    }

    const kind = stringPayload(payload, "kind") ?? "markdown";
    const inlineContent = stringPayload(payload, "content");
    const storedContent = operation.operationType === "file_upsert" &&
      kind !== "folder" &&
      inlineContent === undefined
      ? await this.storedContentRefInClient(client, operation)
      : undefined;
    if (
      operation.operationType === "file_upsert" &&
      kind !== "folder" &&
      inlineContent === undefined &&
      !storedContent
    ) {
      throw new MissingFileContentError(operation.opId);
    }

    const previousSize = await this.activeFileSizeInClient(
      client,
      operation.vaultId,
      fileId,
      path,
    );
    const nextSize = kind === "folder"
      ? 0
      : numberPayload(payload, "sizeBytes") ??
        storedContent?.sizeBytes ??
        (inlineContent !== undefined ? Buffer.byteLength(inlineContent, "utf8") : undefined);
    const contentType = stringPayload(payload, "contentType");

    await this.assertActivePathAvailableInClient(
      client,
      operation.vaultId,
      fileId,
      path,
    );

    await client.query(
      `
        insert into files(
          vault_id,
          file_id,
          path,
          kind,
          hash,
          size_bytes,
          mtime_ms,
          deleted_at,
          updated_seq,
          storage_key,
          storage_kind,
          content_type
        )
        values ($1, $2, $3, $4, $5, $6, $7, null, $8, $9, $10, $11)
        on conflict (vault_id, file_id) do update
          set path = excluded.path,
              kind = excluded.kind,
              hash = coalesce(excluded.hash, files.hash),
              size_bytes = coalesce(excluded.size_bytes, files.size_bytes),
              mtime_ms = coalesce(excluded.mtime_ms, files.mtime_ms),
              deleted_at = null,
              updated_seq = excluded.updated_seq,
              storage_key = excluded.storage_key,
              storage_kind = excluded.storage_kind,
              content_type = excluded.content_type,
              updated_at = now()
      `,
      [
        operation.vaultId,
        fileId,
        path,
        kind,
        stringPayload(payload, "hash"),
        nextSize,
        numberPayload(payload, "mtimeMs"),
        operation.serverSeq,
        storedContent?.storageKey,
        storedContent?.storageKind,
        storedContent?.contentType ?? contentType,
      ],
    );

    if (nextSize !== undefined && nextSize !== previousSize) {
      await this.insertLedgerEntry(client, {
        vaultId: operation.vaultId,
        source: "sync",
        deltaLogicalBytes: nextSize - previousSize,
        reason: "file_upserted",
        refId: operation.opId,
      });
    }
  }

  private async ensureVaultInClient(
    client: Pick<PostgresPool, "query">,
    vaultId: string,
  ): Promise<void> {
    await client.query(
      `
        insert into vaults(id, name)
        values ($1, $1)
        on conflict (id) do nothing
      `,
      [vaultId],
    );
  }

  private async upsertDeviceInClient(
    client: QueryClient,
    input: {
      vaultId: string;
      deviceId: string;
      name?: string;
    },
  ): Promise<void> {
    await client.query(
      `
        insert into devices(vault_id, id, name)
        values ($1, $2, $3)
        on conflict (vault_id, id) do update
          set name = excluded.name,
              last_seen_at = now()
      `,
      [input.vaultId, input.deviceId, input.name ?? input.deviceId],
    );
  }

  private async appendOperationInClient(
    client: QueryClient,
    input: AppendOperationInput,
  ): Promise<OperationRecord> {
    const result = await client.query(
      `
        insert into operations(
          vault_id,
          op_id,
          device_id,
          operation_type,
          file_id,
          path,
          payload
        )
        values ($1, $2, $3, $4, $5, $6, $7::jsonb)
        on conflict (vault_id, op_id) do nothing
        returning *
      `,
      [
        input.vaultId,
        input.opId,
        input.deviceId,
        input.operationType,
        input.fileId,
        input.path,
        JSON.stringify(input.payload ?? {}),
      ],
    );

    if (result.rows[0]) {
      const operation = mapOperation(result.rows[0]);
      await this.applyOperationToManifest(client, operation);
      if (input.quotaBytes !== undefined) {
        await this.assertOperationQuotaInClient(client, operation, input.quotaBytes);
      }
      await storeMarkdownVersion(client, {
        ...operation,
        source: historySource(operation.deviceId, operation.opId),
      });
      return operation;
    }

    const existing = await client.query(
      `
        select *
        from operations
        where vault_id = $1 and op_id = $2
        limit 1
      `,
      [input.vaultId, input.opId],
    );

    const existingOperation = mapOperation(existing.rows[0]);
    assertSameOperation(input, existingOperation);
    return existingOperation;
  }

  private async upsertBlobRefInClient(
    client: QueryClient,
    input: UpsertBlobRefInput,
  ): Promise<void> {
    await this.ensureVaultInClient(client, input.vaultId);

    const existing = await client.query(
      `
        select 1
        from blob_refs
        where vault_id = $1 and hash = $2
        limit 1
      `,
      [input.vaultId, input.hash],
    );

    await client.query(
      `
        insert into blob_refs(
          vault_id,
          hash,
          size_bytes,
          storage_key,
          storage_kind,
          content_type,
          orphaned_at,
          deleted_at
        )
        values ($1, $2, $3, $4, $5, $6, null, null)
        on conflict (vault_id, hash) do update
          set size_bytes = excluded.size_bytes,
              storage_key = excluded.storage_key,
              storage_kind = excluded.storage_kind,
              content_type = excluded.content_type,
              orphaned_at = null,
              deleted_at = null
      `,
      [
        input.vaultId,
        input.hash,
        input.sizeBytes,
        input.storageKey,
        input.storageKind,
        input.contentType,
      ],
    );

    if (existing.rowCount === 0) {
      await this.insertLedgerEntry(client, {
        vaultId: input.vaultId,
        source: "sync",
        deltaPhysicalBytes: input.sizeBytes,
        reason: "blob_available",
        refId: input.hash,
      });
    }
  }

  private async updateFileStorageInClient(
    client: QueryClient,
    input: UpdateFileStorageInput,
  ): Promise<void> {
    await this.assertActivePathAvailableInClient(
      client,
      input.vaultId,
      input.fileId,
      input.path,
    );

    await client.query(
      `
        insert into files(
          vault_id,
          file_id,
          path,
          kind,
          hash,
          size_bytes,
          mtime_ms,
          deleted_at,
          updated_seq,
          storage_key,
          storage_kind,
          content_type
        )
        values ($1, $2, $3, $4, $5, $6, $7, null, $8, $9, $10, $11)
        on conflict (vault_id, file_id) do update
          set path = excluded.path,
              kind = excluded.kind,
              hash = excluded.hash,
              size_bytes = excluded.size_bytes,
              mtime_ms = excluded.mtime_ms,
              deleted_at = null,
              updated_seq = excluded.updated_seq,
              storage_key = excluded.storage_key,
              storage_kind = excluded.storage_kind,
              content_type = excluded.content_type,
              updated_at = now()
      `,
      [
        input.vaultId,
        input.fileId,
        input.path,
        input.kind,
        input.hash,
        input.sizeBytes,
        input.mtimeMs,
        input.updatedSeq,
        input.storageKey,
        input.storageKind,
        input.contentType,
      ],
    );
  }

  private async finalizeUploadSessionInClient(
    client: QueryClient,
    uploadId: string,
    finalized: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `
        update upload_sessions
        set status = 'finalized',
            finalized = $2::jsonb,
            updated_at = now()
        where id = $1
      `,
      [uploadId, JSON.stringify(finalized)],
    );
  }

  private async closeQuotaReservationInClient(
    client: QueryClient,
    reservationId: string | undefined,
    status: "finalized" | "expired" | "cancelled",
    reason: string,
    refId?: string,
  ): Promise<void> {
    if (!reservationId) return;

    const existing = await client.query(
      `
        select *
        from quota_reservations
        where id = $1
        for update
      `,
      [reservationId],
    );
    const reservation = existing.rows[0];

    if (!reservation || reservation.status !== "active") {
      return;
    }

    await client.query(
      `
        update quota_reservations
        set status = $2,
            ref_id = coalesce($3, ref_id),
            updated_at = now()
        where id = $1
      `,
      [reservationId, status, refId],
    );

    const bytesReserved = optionalNumber(reservation.bytes_reserved) ?? 0;
    if (bytesReserved > 0) {
      await this.insertLedgerEntry(client, {
        vaultId: String(reservation.vault_id),
        source: String(reservation.source),
        deltaReservedBytes: -bytesReserved,
        reason,
        refId: refId ?? optionalString(reservation.ref_id),
      });
    }
  }

  private async acquireVaultWriteLock(
    client: QueryClient,
    vaultId: string,
  ): Promise<void> {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`obsync:vault:${vaultId}:write`],
    );
  }

  private async activeFileSizeInClient(
    client: Pick<PostgresPool, "query">,
    vaultId: string,
    fileId: string,
    path: string,
  ): Promise<number> {
    return (await this.activeFileRecordInClient(client, vaultId, fileId, path))?.sizeBytes ?? 0;
  }

  private async activeFileRecordInClient(
    client: QueryClient,
    vaultId: string,
    fileId: string,
    path: string,
  ): Promise<{
    fileId: string;
    path: string;
    hash?: string;
    sizeBytes: number;
    updatedSeq?: number;
  } | undefined> {
    const result = await client.query(
      `
        select file_id, path, hash, size_bytes, updated_seq
        from files
        where vault_id = $1
          and deleted_at is null
          and (file_id = $2 or path = $3)
        order by case when file_id = $2 then 0 else 1 end,
                 updated_seq desc nulls last
        limit 1
      `,
      [vaultId, fileId, path],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      fileId: String(row.file_id),
      path: String(row.path),
      hash: optionalString(row.hash),
      sizeBytes: optionalNumber(row.size_bytes) ?? 0,
      updatedSeq: optionalNumber(row.updated_seq),
    };
  }

  private async assertActivePathAvailableInClient(
    client: QueryClient,
    vaultId: string,
    fileId: string,
    path: string,
  ): Promise<void> {
    const result = await client.query(
      `
        select file_id
        from files
        where vault_id = $1
          and path = $2
          and file_id <> $3
          and deleted_at is null
        limit 1
      `,
      [vaultId, path, fileId],
    );
    if (result.rows[0]) {
      throw new FilePathConflictError(path);
    }
  }

  private async storedContentRefInClient(
    client: QueryClient,
    operation: OperationRecord,
  ): Promise<StoredContentRef | undefined> {
    const hash = stringPayload(operation.payload, "hash");
    if (!hash) throw new MissingFileContentError(operation.opId);

    const result = await client.query(
      `
        select storage_key, storage_kind, content_type, size_bytes
        from blob_refs
        where vault_id = $1
          and hash = $2
          and deleted_at is null
        limit 1
      `,
      [operation.vaultId, hash],
    );
    const row = result.rows[0];
    if (!row) return undefined;

    return {
      storageKey: String(row.storage_key),
      storageKind: String(row.storage_kind),
      contentType: optionalString(row.content_type),
      sizeBytes: optionalNumber(row.size_bytes),
    };
  }

  private async activeFileStateInClient(
    client: Pick<PostgresPool, "query">,
    vaultId: string,
    fileId: string,
    path: string,
  ): Promise<{
    hash?: string;
    updatedSeq?: number;
  } | undefined> {
    const row = await this.activeFileRecordInClient(client, vaultId, fileId, path);
    if (!row) return undefined;
    return {
      hash: row.hash,
      updatedSeq: row.updatedSeq,
    };
  }

  private async assertOperationPreconditions(
    client: Pick<PostgresPool, "query">,
    operation: OperationRecord,
    fileId: string,
    path: string,
  ): Promise<void> {
    const expectedHash = stringPayload(operation.payload, "expectedHash");
    const expectedSeq = numberPayload(operation.payload, "expectedSeq");
    if (expectedHash === undefined && expectedSeq === undefined) return;

    const current = await this.activeFileStateInClient(
      client,
      operation.vaultId,
      fileId,
      path,
    );
    if (!current) {
      throw new OperationPreconditionFailedError(
        operation.opId,
        "operation precondition failed: file is missing",
      );
    }

    if (expectedHash !== undefined && current.hash !== expectedHash) {
      throw new OperationPreconditionFailedError(
        operation.opId,
        "operation precondition failed: hash changed",
      );
    }

    if (expectedSeq !== undefined && current.updatedSeq !== expectedSeq) {
      throw new OperationPreconditionFailedError(
        operation.opId,
        "operation precondition failed: sequence changed",
      );
    }
  }

  private async vaultQuotaInClient(
    client: Pick<PostgresPool, "query">,
    vaultId: string,
    quotaBytes?: number,
  ): Promise<number | undefined> {
    if (quotaBytes !== undefined) return quotaBytes;

    const result = await client.query(
      `
        select quota_bytes
        from vault_quotas
        where vault_id = $1
        limit 1
      `,
      [vaultId],
    );

    return optionalNumber(result.rows[0]?.quota_bytes);
  }

  private async storageUsageInClient(
    client: Pick<PostgresPool, "query">,
    vaultId: string,
  ): Promise<Pick<StorageUsageRecord, "logicalBytes" | "reservedBytes">> {
    const result = await client.query(
      `
        with logical_usage as (
          select coalesce(sum(coalesce(size_bytes, 0)), 0)::bigint as bytes
          from files
          where vault_id = $1
            and deleted_at is null
            and kind <> 'folder'
        ),
        reserved_usage as (
          select coalesce(sum(bytes_reserved), 0)::bigint as bytes
          from quota_reservations
          where vault_id = $1
            and status = 'active'
            and expires_at > now()
        )
        select
          (select bytes from logical_usage) as logical_bytes,
          (select bytes from reserved_usage) as reserved_bytes
      `,
      [vaultId],
    );

    return {
      logicalBytes: optionalNumber(result.rows[0]?.logical_bytes) ?? 0,
      reservedBytes: optionalNumber(result.rows[0]?.reserved_bytes) ?? 0,
    };
  }

  private async assertOperationQuotaInClient(
    client: Pick<PostgresPool, "query">,
    operation: OperationRecord,
    quotaBytes?: number,
  ): Promise<void> {
    const payload = operation.payload;
    if (operation.operationType !== "file_upsert") return;
    if ((stringPayload(payload, "kind") ?? "markdown") === "folder") return;

    const fileId = operation.fileId ?? stringPayload(payload, "fileId") ?? operation.path;
    const path = operation.path ?? stringPayload(payload, "path");
    if (!fileId || !path) return;

    const activeFile = await this.activeFileRecordInClient(
      client,
      operation.vaultId,
      fileId,
      path,
    );
    if (!activeFile) return;

    const quota = await this.vaultQuotaInClient(client, operation.vaultId, quotaBytes);
    if (quota === undefined) return;

    const usage = await this.storageUsageInClient(client, operation.vaultId);
    if (usage.logicalBytes + usage.reservedBytes > quota) {
      throw new StorageQuotaExceededError({
        vaultId: operation.vaultId,
        quotaBytes: quota,
        logicalBytes: usage.logicalBytes,
        reservedBytes: usage.reservedBytes,
        requestedBytes: activeFile.sizeBytes,
      });
    }
  }

  private async closeQuotaReservation(
    reservationId: string,
    status: "finalized" | "expired" | "cancelled",
    reason: string,
    refId?: string,
  ): Promise<void> {
    await this.withTransaction(async (client) => {
      await this.closeQuotaReservationInClient(client, reservationId, status, reason, refId);
    });
  }

  private async insertLedgerEntry(
    client: Pick<PostgresPool, "query">,
    input: {
      vaultId: string;
      source: string;
      deltaLogicalBytes?: number;
      deltaPhysicalBytes?: number;
      deltaReservedBytes?: number;
      reason: string;
      refId?: string;
    },
  ): Promise<void> {
    await client.query(
      `
        insert into storage_ledger_entries(
          vault_id,
          source,
          delta_logical_bytes,
          delta_physical_bytes,
          delta_reserved_bytes,
          reason,
          ref_id
        )
        values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        input.vaultId,
        input.source,
        input.deltaLogicalBytes ?? 0,
        input.deltaPhysicalBytes ?? 0,
        input.deltaReservedBytes ?? 0,
        input.reason,
        input.refId,
      ],
    );
  }

  private async withTransaction<T>(
    callback: (client: DatabaseClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await callback(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private normalizeLimit(limit?: number): number {
    if (!limit) return this.defaultPageLimit;
    return Math.max(1, Math.min(limit, this.maxPageLimit));
  }
}

export class OperationIdConflictError extends Error {
  constructor(opId: string) {
    super(`idempotency conflict for opId ${opId}`);
    this.name = "OperationIdConflictError";
  }
}

export class OperationPreconditionFailedError extends Error {
  constructor(readonly opId: string, message: string) {
    super(message);
    this.name = "OperationPreconditionFailedError";
  }
}

export class MissingFileContentError extends Error {
  constructor(readonly opId: string) {
    super(`file_upsert ${opId} is missing file content`);
    this.name = "MissingFileContentError";
  }
}

export class FilePathConflictError extends Error {
  constructor(readonly path: string) {
    super(`file path is already used: ${path}`);
    this.name = "FilePathConflictError";
  }
}

function mapVault(row: Record<string, unknown>): VaultRecord {
  return {
    id: String(row.id),
    name: String(row.name),
  };
}

function mapOperation(row: Record<string, unknown>): OperationRecord {
  return {
    serverSeq: Number(row.server_seq),
    vaultId: String(row.vault_id),
    opId: String(row.op_id),
    deviceId: String(row.device_id),
    operationType: String(row.operation_type),
    fileId: optionalString(row.file_id),
    path: optionalString(row.path),
    payload: jsonObject(row.payload),
    createdAt: dateString(row.created_at),
  };
}

async function storeMarkdownVersion(
  client: Pick<PostgresPool, "query">,
  input: OperationRecord & {
    source: string;
  },
): Promise<void> {
  if (input.operationType !== "file_upsert") return;
  if (stringPayload(input.payload, "kind") !== "markdown") return;
  if (!input.path || isObsidianPath(input.path)) return;

  const fileId = input.fileId ?? input.path;
  if (!fileId) return;
  const markdown = stringPayload(input.payload, "content");
  if (markdown === undefined) return;
  if (containsPostgresUnsafeText(markdown)) return;

  const sourceHash = stringPayload(input.payload, "hash");
  if (!sourceHash) return;
  const sizeBytes = numberPayload(input.payload, "sizeBytes") ?? Buffer.byteLength(markdown, "utf8");
  await client.query(
    `
      insert into markdown_versions(
        vault_id,
        file_id,
        path,
        server_seq,
        op_id,
        device_id,
        source,
        hash,
        size_bytes,
        markdown
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10)
    `,
    [
      input.vaultId,
      fileId,
      input.path,
      input.serverSeq,
      input.opId,
      input.deviceId,
      input.source,
      sourceHash,
      sizeBytes,
      markdown,
    ],
  );

  await client.query(
    `
      delete from markdown_versions
      where vault_id = $1
        and file_id = $2
        and server_seq not in (
          select server_seq
          from markdown_versions
          where vault_id = $1
            and file_id = $2
          order by server_seq desc
          limit $3
        )
    `,
    [input.vaultId, fileId, MARKDOWN_VERSIONS_RETENTION_LIMIT],
  );
}

function mapHistoryEntry(row: Record<string, unknown>): HistoryEntry {
  const payload = entryPayload(row);
  const operationType = String(row.operation_type);
  const kind = stringPayload(payload, "kind");
  const hash = stringPayload(payload, "hash");
  const inlineContent = stringPayload(payload, "content");
  const storageKey = optionalString(row.history_storage_key);
  const historyMarkdown = optionalString(row.history_markdown);
  const contentAvailable = operationType === "file_upsert" &&
    kind === "markdown" &&
    Boolean(
      inlineContent !== undefined ||
      historyMarkdown !== undefined ||
      storageKey,
    );

  return {
    serverSeq: Number(row.server_seq),
    opId: String(row.op_id),
    deviceId: String(row.device_id),
    source: historySource(String(row.device_id), String(row.op_id)),
    operationType,
    fileId: optionalString(row.file_id),
    path: optionalString(row.path),
    targetPath: stringPayload(payload, "newPath"),
    kind,
    hash,
    sizeBytes: numberPayload(payload, "sizeBytes"),
    mtimeMs: numberPayload(payload, "mtimeMs"),
    createdAt: dateString(row.created_at),
    contentAvailable,
  };
}

function mapFileEntry(row: Record<string, unknown>): FileEntry {
  return {
    vaultId: String(row.vault_id),
    fileId: String(row.file_id),
    path: String(row.path),
    kind: String(row.kind),
    hash: optionalString(row.hash),
    sizeBytes: optionalNumber(row.size_bytes),
    mtimeMs: optionalNumber(row.mtime_ms),
    deletedAt: row.deleted_at ? dateString(row.deleted_at) : undefined,
    updatedSeq: optionalNumber(row.updated_seq),
    storageKey: optionalString(row.storage_key),
    storageKind: optionalString(row.storage_kind),
    contentType: optionalString(row.content_type),
  };
}

function mapStorageReservation(row: Record<string, unknown>): StorageReservationRecord {
  const status = String(row.status);
  if (
    status !== "active" &&
    status !== "finalized" &&
    status !== "expired" &&
    status !== "cancelled"
  ) {
    throw new Error(`invalid quota reservation status: ${status}`);
  }

  return {
    id: String(row.id),
    vaultId: String(row.vault_id),
    bytesReserved: optionalNumber(row.bytes_reserved) ?? 0,
    status,
    expiresAt: dateString(row.expires_at),
  };
}

function mapOrphanBlobRef(row: Record<string, unknown>): OrphanBlobRef {
  return {
    vaultId: String(row.vault_id),
    hash: String(row.hash),
    sizeBytes: optionalNumber(row.size_bytes) ?? 0,
    storageKey: String(row.storage_key),
    storageKind: String(row.storage_kind),
  };
}

function mapUploadSession(row: Record<string, unknown>): UploadSessionRecord {
  const status = String(row.status);
  if (status !== "uploading" && status !== "finalizing" && status !== "finalized") {
    throw new Error(`invalid upload session status: ${status}`);
  }

  return {
    uploadId: String(row.id),
    vaultId: String(row.vault_id),
    deviceId: String(row.device_id),
    fileId: String(row.file_id),
    path: String(row.path),
    kind: String(row.kind),
    sizeBytes: optionalNumber(row.size_bytes) ?? 0,
    mtimeMs: optionalNumber(row.mtime_ms),
    contentType: optionalString(row.content_type),
    expectedHash: optionalString(row.expected_hash),
    expectedCurrentHash: optionalString(row.expected_current_hash),
    expectedCurrentSeq: optionalNumber(row.expected_current_seq),
    chunkSize: optionalNumber(row.chunk_size_bytes) ?? 0,
    quotaReservationId: optionalString(row.quota_reservation_id),
    status,
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at),
    expiresAt: dateString(row.expires_at),
    finalized: row.finalized ? jsonObject(row.finalized) : undefined,
  };
}

function mapUploadChunk(row: Record<string, unknown>): UploadChunkRecord {
  return {
    uploadId: String(row.upload_session_id),
    index: optionalNumber(row.chunk_index) ?? 0,
    sizeBytes: optionalNumber(row.size_bytes) ?? 0,
    hash: String(row.hash),
    receivedAt: dateString(row.received_at),
  };
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function entryPayload(row: Record<string, unknown>): Record<string, unknown> {
  return jsonObject(row.payload);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return undefined;
  return String(value);
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringPayload(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function containsPostgresUnsafeText(value: string): boolean {
  return value.includes("\u0000");
}

function numberPayload(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function historySource(deviceId: string, opId: string): HistoryEntry["source"] {
  void opId;
  if (deviceId) return "device";
  return "unknown";
}

function isObsidianPath(value: string): boolean {
  return value === ".obsidian" || value.startsWith(".obsidian/");
}

function dateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function assertSameOperation(
  input: AppendOperationInput,
  existing: OperationRecord,
): void {
  if (
    input.vaultId !== existing.vaultId ||
    input.deviceId !== existing.deviceId ||
    input.operationType !== existing.operationType ||
    (input.fileId ?? undefined) !== (existing.fileId ?? undefined) ||
    (input.path ?? undefined) !== (existing.path ?? undefined) ||
    canonicalJson(input.payload ?? {}) !== canonicalJson(existing.payload)
  ) {
    throw new OperationIdConflictError(input.opId);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export class StorageQuotaExceededError extends Error {
  readonly vaultId: string;
  readonly quotaBytes: number;
  readonly logicalBytes: number;
  readonly reservedBytes: number;
  readonly requestedBytes: number;

  constructor(input: {
    vaultId: string;
    quotaBytes: number;
    logicalBytes: number;
    reservedBytes: number;
    requestedBytes: number;
  }) {
    super("storage quota exceeded");
    this.vaultId = input.vaultId;
    this.quotaBytes = input.quotaBytes;
    this.logicalBytes = input.logicalBytes;
    this.reservedBytes = input.reservedBytes;
    this.requestedBytes = input.requestedBytes;
  }
}
