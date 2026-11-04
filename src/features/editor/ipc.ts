/** Leer y guardar archivos para las tabs. Ver `explorer/files.rs`. */
import { invoke } from "@tauri-apps/api/core";

/** Token opaco `tamanho:mtime_ns[:inode]`: só se compara por igualdade. */
export type FileVersion = string;

export type FileContent =
  | { kind: "text"; content: string; mtime: number; size: number; version: FileVersion }
  | { kind: "image"; dataUrl: string; mtime: number; size: number; version: FileVersion }
  | { kind: "binary"; size: number }
  | { kind: "tooLarge"; size: number };

/** `version: null` no conflito = o arquivo não existe mais. */
export type WriteOutcome =
  | { kind: "saved"; mtime: number; version: FileVersion }
  | { kind: "conflict"; mtime: number | null; version: FileVersion | null };

/** O `expectedVersion` de quem quer criar: só grava se o nome continua livre. */
export const ABSENT: FileVersion = "absent";

export const readFile = (path: string) => invoke<FileContent>("explorer_read_file", { path });

/** `expectedVersion: null` = sobrescribir sin mirar (el usuario lo eligió). `ABSENT` = criar. */
export const writeFile = (path: string, content: string, expectedVersion: FileVersion | null) =>
  invoke<WriteOutcome>("explorer_write_file", { path, content, expectedVersion });

/** `null` = el archivo ya no existe. */
export const fileStat = (path: string) =>
  invoke<{ mtime: number; size: number; version: FileVersion } | null>("explorer_file_stat", { path });
