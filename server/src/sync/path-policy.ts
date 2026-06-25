export interface VaultPathPolicy {
  allowObsidianConfig?: boolean;
  allowObsidianPlugins?: boolean;
  allowLongSegments?: boolean;
}

export const SYNC_VAULT_PATH_POLICY: VaultPathPolicy = {
  allowObsidianConfig: true,
  allowObsidianPlugins: true,
};

export class InvalidVaultPathError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "InvalidVaultPathError";
  }
}

const MAX_VAULT_PATH_LENGTH = 4096;
const MAX_VAULT_PATH_SEGMENT_BYTES = 255;
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ENCODED_TRAVERSAL = /%(?:2e|2f|5c)/i;

const ALWAYS_BLOCKED_PATHS = new Set([
  ".obsidian/plugins/obsync",
  ".obsidian/cache",
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
]);

export function validateVaultPath(
  path: string,
  policy: VaultPathPolicy = {},
): string {
  const normalized = normalizeVaultPath(path);
  const error = invalidVaultPathReason(normalized, policy, path);
  if (error) throw new InvalidVaultPathError(error);
  return normalized;
}

export function isValidVaultPath(
  path: string,
  policy: VaultPathPolicy = {},
): boolean {
  return !invalidVaultPathReason(normalizeVaultPath(path), policy, path);
}

export function validateSyncVaultPath(path: string): string {
  return validateVaultPath(path, SYNC_VAULT_PATH_POLICY);
}

function normalizeVaultPath(path: string): string {
  return path.normalize("NFC").replace(/\\/g, "/");
}

function invalidVaultPathReason(
  normalized: string,
  policy: VaultPathPolicy,
  original: string,
): string | undefined {
  if (!normalized) return "invalid vault path: empty";
  if (normalized.length > MAX_VAULT_PATH_LENGTH) return "invalid vault path: too long";
  if (CONTROL_CHARS.test(normalized)) return "invalid vault path: control character";
  if (ENCODED_TRAVERSAL.test(original)) return "invalid vault path: encoded traversal";
  if (normalized.startsWith("/") || WINDOWS_DRIVE_PATH.test(normalized)) {
    return "invalid vault path: absolute path";
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return "invalid vault path: unsafe segment";
  }
  if (
    !policy.allowLongSegments &&
    segments.some((segment) => Buffer.byteLength(segment, "utf8") > MAX_VAULT_PATH_SEGMENT_BYTES)
  ) {
    return "invalid vault path: segment too long";
  }

  if (isBlockedInternalPath(normalized)) return "invalid vault path: internal obsync path";
  if (!policy.allowObsidianPlugins && isObsidianPluginPath(normalized)) {
    return "invalid vault path: obsidian plugins are blocked";
  }
  if (!policy.allowObsidianConfig && isObsidianConfigPath(normalized)) {
    return "invalid vault path: obsidian config is blocked";
  }

  return undefined;
}

function isBlockedInternalPath(path: string): boolean {
  const normalized = path.toLowerCase();
  if (isVolatileWorkspacePath(normalized)) return true;

  return [...ALWAYS_BLOCKED_PATHS].some((blockedPath) => (
    normalized === blockedPath || normalized.startsWith(`${blockedPath}/`)
  ));
}

function isVolatileWorkspacePath(path: string): boolean {
  return path.startsWith(".obsidian/workspace") && path.endsWith(".json");
}

function isObsidianPluginPath(path: string): boolean {
  return path === ".obsidian/plugins" || path.startsWith(".obsidian/plugins/");
}

function isObsidianConfigPath(path: string): boolean {
  return path === ".obsidian" || path.startsWith(".obsidian/");
}
