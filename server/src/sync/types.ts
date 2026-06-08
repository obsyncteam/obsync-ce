export interface VaultRecord {
  id: string;
  name: string;
}

export interface OperationRecord {
  serverSeq: number;
  vaultId: string;
  opId: string;
  deviceId: string;
  operationType: string;
  fileId?: string;
  path?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface OperationPage {
  operations: OperationRecord[];
  nextCursor: number;
  hasMore: boolean;
}

export type HistorySource = "device" | "unknown";

export interface HistoryEntry {
  serverSeq: number;
  opId: string;
  deviceId: string;
  source: HistorySource;
  operationType: string;
  fileId?: string;
  path?: string;
  targetPath?: string;
  kind?: string;
  hash?: string;
  sizeBytes?: number;
  mtimeMs?: number;
  createdAt: string;
  contentAvailable: boolean;
}

export interface HistoryPage {
  file: {
    vaultId: string;
    path: string;
    fileId?: string;
  };
  entries: HistoryEntry[];
  nextCursor?: number;
  hasMore: boolean;
}

export interface HistoryVersion {
  entry: HistoryEntry;
  content?: string;
  storageKey?: string;
  contentType?: string;
  sizeBytes?: number;
  hash?: string;
}

export interface FileEntry {
  vaultId: string;
  fileId: string;
  path: string;
  kind: string;
  hash?: string;
  sizeBytes?: number;
  mtimeMs?: number;
  deletedAt?: string;
  updatedSeq?: number;
  storageKey?: string;
  storageKind?: string;
  contentType?: string;
}

export interface ManifestPage {
  manifest: FileEntry[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface AppendOperationInput {
  vaultId: string;
  opId: string;
  deviceId: string;
  operationType: string;
  fileId?: string;
  path?: string;
  payload: Record<string, unknown>;
}

export interface UpsertBlobRefInput {
  vaultId: string;
  hash: string;
  sizeBytes: number;
  storageKey: string;
  storageKind: string;
  contentType?: string;
}

export interface UpdateFileStorageInput {
  vaultId: string;
  fileId: string;
  path: string;
  kind: string;
  hash: string;
  sizeBytes: number;
  mtimeMs?: number;
  storageKey: string;
  storageKind: string;
  contentType?: string;
  updatedSeq: number;
}

export interface UploadedFileRecord {
  vaultId: string;
  fileId: string;
  path: string;
  kind: string;
  hash: string;
  sizeBytes: number;
  mtimeMs?: number;
  storageKey: string;
  storageKind: string;
  contentType?: string;
}

export interface CommitUploadedFileInput extends UploadedFileRecord {
  deviceId: string;
  opId: string;
  content?: string;
  expectedHash?: string;
  expectedSeq?: number;
  quotaReservationId?: string;
  uploadId?: string;
}

export interface CommitUploadedFileResult {
  file: UploadedFileRecord;
  operation: OperationRecord;
  finalized?: Record<string, unknown>;
}

export interface StorageReservationRecord {
  id: string;
  vaultId: string;
  bytesReserved: number;
  status: "active" | "finalized" | "expired" | "cancelled";
  expiresAt: string;
}

export interface StorageUsageRecord {
  vaultId: string;
  logicalBytes: number;
  physicalBytes: number;
  reservedBytes: number;
  quotaBytes?: number;
}

export interface ReserveStorageInput {
  vaultId: string;
  fileId: string;
  path: string;
  sizeBytes: number;
  source: string;
  refId: string;
  idempotencyKey: string;
  expiresAt: Date;
  quotaBytes?: number;
}

export interface OrphanBlobRef {
  vaultId: string;
  hash: string;
  sizeBytes: number;
  storageKey: string;
  storageKind: string;
}

export interface UploadSessionRecord {
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
  status: "uploading" | "finalizing" | "finalized";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  finalized?: Record<string, unknown>;
}

export interface UploadChunkRecord {
  uploadId: string;
  index: number;
  sizeBytes: number;
  hash: string;
  receivedAt: string;
}
