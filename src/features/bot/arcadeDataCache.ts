const inflight = new Map<string, Promise<unknown>>();

/** Uma missão, uma chamada: a grade não dispara 3 IPC por célula em paralelo. */
export function shareMissionFetch<T>(missionId: string, key: string, run: () => Promise<T>): Promise<T> {
  const id = `${missionId}:${key}`;
  const existing = inflight.get(id);
  if (existing) return existing as Promise<T>;
  const p = run().finally(() => { inflight.delete(id); });
  inflight.set(id, p);
  return p;
}

