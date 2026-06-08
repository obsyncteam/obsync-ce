const vaultLocks = new Map<string, Promise<void>>();

export async function withVaultMutationLock<T>(
  vaultId: string,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = vaultLocks.get(vaultId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current, () => current);
  vaultLocks.set(vaultId, chained);

  await previous.catch(() => undefined);
  try {
    return await callback();
  } finally {
    release();
    if (vaultLocks.get(vaultId) === chained) {
      vaultLocks.delete(vaultId);
    }
  }
}
