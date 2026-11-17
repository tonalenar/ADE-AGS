/** Switch otimista: se o IPC falhar, volta ao valor anterior. */
export async function persistAutoSync(
  next: boolean,
  setLocal: (v: boolean) => void,
  persist: (v: boolean) => Promise<void>,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const previous = !next;
  setLocal(next);
  try {
    await persist(next);
    return { ok: true };
  } catch (error) {
    setLocal(previous);
    return { ok: false, error };
  }
}
