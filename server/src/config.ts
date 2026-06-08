export type BlobStoreKind = "filesystem" | "s3";

export interface DatabaseConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export interface ServerConfig {
  host: string;
  port: number;
  database: DatabaseConfig;
  authToken: string;
  blobStore: BlobStoreKind;
  dataDir: string;
  allowedOrigins: string[];
  storageQuotaBytes?: number;
  maxJsonBodyBytes: number;
  maxDirectUploadBytes: number;
  maxWsMessageBytes: number;
  maxHttpConnections: number;
  maxWsSessions: number;
  s3?: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
  };
}

const PLACEHOLDER_VALUES = new Set([
  "change-me",
  "change-this-token",
  "change-this-password",
  "change-this-access-key",
  "change-this-secret-key",
]);

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requiredSecretEnv(name: string, minLength: number): string {
  const value = requiredEnv(name);
  if (PLACEHOLDER_VALUES.has(value) || value.length < minLength) {
    throw new Error(
      `Environment variable ${name} must be a real random secret at least ${minLength} characters long`,
    );
  }
  return value;
}

function rejectPlaceholderValue(name: string, value: string): void {
  if (PLACEHOLDER_VALUES.has(value) || value.includes("change-me")) {
    throw new Error(`Environment variable ${name} contains a placeholder value`);
  }
}

function optionalSecretEnv(name: string): string | undefined {
  const value = optionalEnv(name);
  if (value) rejectPlaceholderValue(name, value);
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const value = optionalEnv(name);
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }

  return parsed;
}

function optionalPositiveNumber(name: string): number | undefined {
  const value = optionalEnv(name);
  if (!value) return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }

  return parsed > 0 ? parsed : undefined;
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const value = optionalEnv(name);
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid boolean environment variable: ${name}`);
}

function optionalCsv(name: string): string[] {
  const value = optionalEnv(name);
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function loadDatabaseConfig(): DatabaseConfig {
  const connectionString = optionalEnv("DATABASE_URL");
  if (connectionString) {
    rejectPlaceholderValue("DATABASE_URL", connectionString);
    return { connectionString };
  }

  const password = requiredSecretEnv("OBSYNC_POSTGRES_PASSWORD", 16);
  return {
    host: optionalEnv("OBSYNC_POSTGRES_HOST") ?? "postgres",
    port: optionalNumber("OBSYNC_POSTGRES_PORT", 5432),
    database: optionalEnv("OBSYNC_POSTGRES_DB") ?? "obsync",
    user: optionalEnv("OBSYNC_POSTGRES_USER") ?? "obsync",
    password,
  };
}

export function loadConfig(): ServerConfig {
  const s3Bucket = optionalEnv("OBSYNC_S3_BUCKET");
  const s3Endpoint = optionalEnv("OBSYNC_S3_ENDPOINT");
  const hasS3 =
    Boolean(s3Bucket) ||
    Boolean(s3Endpoint);

  const blobStore: BlobStoreKind = hasS3 ? "s3" : "filesystem";

  return {
    host: optionalEnv("OBSYNC_HOST") ?? "0.0.0.0",
    port: optionalNumber("OBSYNC_PORT", 4444),
    database: loadDatabaseConfig(),
    authToken: requiredSecretEnv("OBSYNC_AUTH_TOKEN", 32),
    blobStore,
    dataDir: optionalEnv("OBSYNC_DATA_DIR") ?? "/data",
    allowedOrigins: optionalCsv("OBSYNC_ALLOWED_ORIGINS"),
    storageQuotaBytes: optionalPositiveNumber("OBSYNC_STORAGE_QUOTA_BYTES"),
    maxJsonBodyBytes: optionalNumber("OBSYNC_MAX_JSON_BODY_BYTES", 1024 * 1024),
    maxDirectUploadBytes: optionalNumber("OBSYNC_MAX_DIRECT_UPLOAD_BYTES", 32 * 1024 * 1024),
    maxWsMessageBytes: optionalNumber("OBSYNC_MAX_WS_MESSAGE_BYTES", 1024 * 1024),
    maxHttpConnections: optionalNumber("OBSYNC_MAX_HTTP_CONNECTIONS", 1024),
    maxWsSessions: optionalNumber("OBSYNC_MAX_WS_SESSIONS", 256),
    s3: hasS3
      ? {
          endpoint: s3Endpoint,
          region: optionalEnv("OBSYNC_S3_REGION") ?? "auto",
          bucket: requiredEnv("OBSYNC_S3_BUCKET"),
          accessKeyId: optionalSecretEnv("OBSYNC_S3_ACCESS_KEY_ID"),
          secretAccessKey: optionalSecretEnv("OBSYNC_S3_SECRET_ACCESS_KEY"),
          forcePathStyle: optionalBoolean("OBSYNC_S3_FORCE_PATH_STYLE", true),
        }
      : undefined,
  };
}
