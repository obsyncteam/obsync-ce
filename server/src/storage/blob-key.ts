export function blobStorageKey(vaultId: string, hash: string): string {
  const safeVaultId = vaultId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const hashHex = hash.replace(/^sha256:/, "");
  return `vaults/${safeVaultId}/blobs/${hashHex.slice(0, 2)}/${hashHex}`;
}
