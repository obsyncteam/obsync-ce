import { z } from "zod";
import { validateSyncVaultPath } from "./path-policy.js";

export const syncVaultPathSchema = z.string().min(1).transform(validateSyncVaultPath);

const opIdSchema = z.string().min(1).max(256);
const deviceIdSchema = z.string().min(1).max(256);
const vaultIdSchema = z.string().min(1).max(256);
const fileIdSchema = z.string().min(1).max(4096);
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/).optional();

const kindSchema = z.enum(["markdown", "blob", "folder"]);
const fileKindSchema = z.enum(["markdown", "blob"]);

const baseOperationSchema = z.object({
  opId: opIdSchema,
  deviceId: deviceIdSchema.optional(),
  fileId: fileIdSchema.optional(),
  path: syncVaultPathSchema,
});

const fileUpsertSchema = baseOperationSchema.extend({
  operationType: z.literal("file_upsert"),
  payload: z.object({
    kind: fileKindSchema,
    hash: hashSchema,
    sizeBytes: z.number().int().nonnegative().optional(),
    mtimeMs: z.number().int().nonnegative().optional(),
    contentType: z.string().min(1).max(256).optional(),
    contentStored: z.boolean().optional(),
    content: z.string().optional(),
    expectedHash: hashSchema,
    expectedSeq: z.number().int().nonnegative().optional(),
  }).strict(),
});

const folderUpsertSchema = baseOperationSchema.extend({
  operationType: z.literal("folder_upsert"),
  payload: z.object({
    kind: z.literal("folder").optional(),
  }).strict().default({ kind: "folder" }),
});

const deleteSchema = baseOperationSchema.extend({
  operationType: z.literal("delete"),
  payload: z.object({
    kind: kindSchema.optional(),
    expectedHash: hashSchema,
    expectedSeq: z.number().int().nonnegative().optional(),
  }).strict().default({}),
});

const renameSchema = baseOperationSchema.extend({
  operationType: z.literal("rename"),
  payload: z.object({
    kind: kindSchema.optional(),
    newPath: syncVaultPathSchema,
    expectedHash: hashSchema,
    expectedSeq: z.number().int().nonnegative().optional(),
  }).strict(),
});

const operationSchema = z.discriminatedUnion("operationType", [
  fileUpsertSchema,
  folderUpsertSchema,
  deleteSchema,
  renameSchema,
]);

export const appendOperationSchema = operationSchema.and(z.object({
  vaultId: vaultIdSchema,
  deviceId: deviceIdSchema,
}));

export const clientOperationSchema = operationSchema.and(z.object({
  type: z.literal("operation"),
}));
