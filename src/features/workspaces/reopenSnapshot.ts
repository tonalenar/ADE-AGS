/** Só esquece o snapshot depois que as abas foram recriadas. */
export async function consumeSnapshotAfterRestore<T>(opts: {
  peek: () => Promise<T | null>;
  restore: (snap: T) => Promise<void>;
  take: () => Promise<void>;
}): Promise<T | null> {
  const snap = await opts.peek();
  if (!snap) return null;
  await opts.restore(snap);
  await opts.take();
  return snap;
}
