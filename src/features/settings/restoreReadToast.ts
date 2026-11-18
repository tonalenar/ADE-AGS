/** Primeira falha de leitura avisa; focus/storage/tema seguintes não repetem. Restore sempre avisa. */
export function shouldToastRestoreRead(source: "refresh" | "restore", alreadyFailed: boolean): boolean {
  if (source === "restore") return true;
  return !alreadyFailed;
}
