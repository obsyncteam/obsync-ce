export type BlobStoreKind = "filesystem" | "s3";

export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  authToken: string;
  enableWebRoutes: boolean;
  blobStore: BlobStoreKind;
  dataDir: string;
  storageQuotaBytes?: number;
  maxJsonBodyBytes: number;
  maxDirectUploadBytes: number;
  maxWsMessageBytes: number;
  s3?: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }

  return parsed;
}

function optionalPositiveNumber(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }

  return parsed > 0 ? parsed : undefined;
}

export function loadConfig(): ServerConfig {
  const hasS3 =
    Boolean(process.env.OBSYNC_S3_BUCKET) ||
    Boolean(process.env.OBSYNC_S3_ENDPOINT);

  const blobStore: BlobStoreKind = hasS3 ? "s3" : "filesystem";

  return {
    host: process.env.OBSYNC_HOST ?? "0.0.0.0",
    port: optionalNumber("OBSYNC_PORT", 4444),
    databaseUrl: requiredEnv("DATABASE_URL"),
    authToken: requiredEnv("OBSYNC_AUTH_TOKEN"),
    enableWebRoutes: process.env.OBSYNC_ENABLE_WEB_ROUTES !== "false",
    blobStore,
    dataDir: process.env.OBSYNC_DATA_DIR ?? "/data",
    storageQuotaBytes: optionalPositiveNumber("OBSYNC_STORAGE_QUOTA_BYTES"),
    maxJsonBodyBytes: optionalNumber("OBSYNC_MAX_JSON_BODY_BYTES", 1024 * 1024),
    maxDirectUploadBytes: optionalNumber("OBSYNC_MAX_DIRECT_UPLOAD_BYTES", 32 * 1024 * 1024),
    maxWsMessageBytes: optionalNumber("OBSYNC_MAX_WS_MESSAGE_BYTES", 1024 * 1024),
    s3: hasS3
      ? {
          endpoint: process.env.OBSYNC_S3_ENDPOINT,
          region: process.env.OBSYNC_S3_REGION ?? "auto",
          bucket: requiredEnv("OBSYNC_S3_BUCKET"),
          accessKeyId: process.env.OBSYNC_S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.OBSYNC_S3_SECRET_ACCESS_KEY,
          forcePathStyle: process.env.OBSYNC_S3_FORCE_PATH_STYLE !== "false",
        }
      : undefined,
  };
}
