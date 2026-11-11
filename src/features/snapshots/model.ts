import type { SnapshotItem } from "./ipc";

/** A legenda de uma captura: o app e o título da janela, separados por " · ". Vazia quando não há JSON. Pura. */
export function snapshotLabel(item: SnapshotItem): string {
  return [item.app, item.title]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join(" · ");
}

/** O instante de uma captura em milissegundos: o do JSON quando lê, senão o do arquivo. Pura. */
export function snapshotTime(item: SnapshotItem): number {
  const parsed = item.capturedAt ? Date.parse(item.capturedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : item.modifiedMs;
}

/** Copiar para a área de transferência só existe no macOS (é a cópia de PNG que o app tem). Pura. */
export function snapshotCanCopy(os: string): boolean {
  return os === "macos";
}
