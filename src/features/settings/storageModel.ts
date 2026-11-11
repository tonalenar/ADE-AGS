import type { StorageArea } from "@/features/settings/ipc";

/**
 * O que a página Armazenamento mostra, sem React: o tamanho em texto e os totais. Os números vêm do backend
 * (`src-tauri/src/storage_usage.rs`); aqui só se formata.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * Um tamanho em bytes como texto curto ("512 B", "1.2 MB", "34 MB"). A unidade é a mesma em qualquer idioma,
 * então não passa pelo locale. Zero, negativo ou inválido vira "0 B".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

export interface StorageTotals {
  readonly bytes: number;
  readonly files: number;
  /** Quanto a limpeza removeria no total (só das áreas que se limpam). */
  readonly oldBytes: number;
  readonly oldFiles: number;
}

export function storageTotals(areas: readonly StorageArea[]): StorageTotals {
  return areas.reduce<StorageTotals>(
    (total, area) => ({
      bytes: total.bytes + area.bytes,
      files: total.files + area.files,
      oldBytes: total.oldBytes + area.oldBytes,
      oldFiles: total.oldFiles + area.oldFiles,
    }),
    { bytes: 0, files: 0, oldBytes: 0, oldFiles: 0 },
  );
}
