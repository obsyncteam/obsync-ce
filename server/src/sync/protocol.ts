export const OBSYNC_SERVER_VERSION = "1.7.4";
export const OBSYNC_PROTOCOL_VERSION = 1;
export const OBSYNC_MIN_CLIENT_PROTOCOL_VERSION = 1;
export const OBSYNC_MIN_CLIENT_VERSION = "1.6.8";
export const OBSYNC_LATEST_CLIENT_VERSION = "1.7.4";

export const OBSYNC_CAPABILITIES = [
  "postgres-metadata",
  "filesystem-or-s3-blobs",
  "direct-small-file-upload",
  "chunk-upload",
  "range-download",
  "upload-session-db",
  "operation-preconditions",
  "obsidian-config-opt-in",
  "history-lite",
  "markdown-version-history",
  "tombstone-context",
] as const;

export interface CompatibilityInput {
  clientVersion?: string;
  protocolVersion?: number;
}

export interface CompatibilityResult {
  ok: true;
  service: "obsync-server";
  serverVersion: string;
  protocolVersion: number;
  minClientProtocolVersion: number;
  minClientVersion: string;
  latestClientVersion: string;
  compatible: boolean;
  upgradeRequired: boolean;
  capabilities: string[];
  message?: string;
}

export function buildCompatibilityResult(
  input: CompatibilityInput = {},
): CompatibilityResult {
  const protocolVersion = input.protocolVersion;
  const clientVersion = input.clientVersion?.trim();
  let compatible = true;
  let upgradeRequired = false;
  let message: string | undefined;

  if (
    protocolVersion !== undefined &&
    (!Number.isInteger(protocolVersion) || protocolVersion < OBSYNC_MIN_CLIENT_PROTOCOL_VERSION)
  ) {
    compatible = false;
    upgradeRequired = true;
    message = `client protocol ${protocolVersion} is older than required ${OBSYNC_MIN_CLIENT_PROTOCOL_VERSION}`;
  }

  if (
    clientVersion &&
    compareVersion(clientVersion, OBSYNC_MIN_CLIENT_VERSION) < 0
  ) {
    compatible = false;
    upgradeRequired = true;
    message = `client version ${clientVersion} is older than required ${OBSYNC_MIN_CLIENT_VERSION}`;
  }

  return {
    ok: true,
    service: "obsync-server",
    serverVersion: OBSYNC_SERVER_VERSION,
    protocolVersion: OBSYNC_PROTOCOL_VERSION,
    minClientProtocolVersion: OBSYNC_MIN_CLIENT_PROTOCOL_VERSION,
    minClientVersion: OBSYNC_MIN_CLIENT_VERSION,
    latestClientVersion: OBSYNC_LATEST_CLIENT_VERSION,
    compatible,
    upgradeRequired,
    capabilities: [...OBSYNC_CAPABILITIES],
    message,
  };
}

export function compareVersion(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }

  return 0;
}

function parseVersion(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, "")
    .split(/[.-]/)
    .map((part) => Number(part))
    .map((part) => (Number.isInteger(part) && part >= 0 ? part : 0));
}
