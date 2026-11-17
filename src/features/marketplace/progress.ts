import type { RegistryProgress } from "./types";

/** Aviso de falha parcial preservado no evento final `done`, quando existe. */
export function registryProgressWarning(progress: RegistryProgress | null): string | null {
  return progress?.phase === "done" ? progress.detail : null;
}
