export function blobStorageKey(vaultId: string, hash: string): string {
  const safeVaultId = Buffer.from(vaultId, "utf8").toString("base64url");
  const hashHex = hash.replace(/^sha256:/, "");
  return `vaults/${safeVaultId}/blobs/${hashHex.slice(0, 2)}/${hashHex}`;
}
