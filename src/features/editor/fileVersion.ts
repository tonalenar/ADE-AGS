import { ABSENT, type FileVersion, type WriteOutcome } from "./ipc";

/**
 * O que a tab de arquivo manda como `expectedVersion` ao salvar (ver `explorer/files.rs`).
 *
 * - O usuário escolheu sobrescrever: `null`, grava sem olhar.
 * - O arquivo sumiu do disco: `ABSENT`, recria só se ninguém ocupou o nome nesse meio-tempo.
 * - No resto, a versão que a tab leu: se outro mudou o arquivo, é conflito.
 */
export function expectedVersionForSave(opts: {
  overwrite: boolean;
  deleted: boolean;
  version: FileVersion | null;
}): FileVersion | null {
  if (opts.overwrite) return null;
  if (opts.deleted) return ABSENT;
  // Nunca leu uma versão (não deveria acontecer com texto aberto): cria, não pisa.
  return opts.version ?? ABSENT;
}

/** O aviso que um conflito pede: sumiu (salvar recria) ou mudou (recarregar ou substituir). */
export function bannerForConflict(outcome: Extract<WriteOutcome, { kind: "conflict" }>): "deleted" | "conflict" {
  return outcome.version === null ? "deleted" : "conflict";
}
