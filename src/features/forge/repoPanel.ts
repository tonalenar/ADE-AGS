import type { RepoTarget } from "./types";

/** Cuántas ramas se muestran como chips en la columna; el resto se cuenta con "+N". */
export const BRANCH_CHIPS = 2;

/** Parte la lista de ramas en las que se muestran y cuántas quedan afuera. */
export function branchChips(branches: string[], max = BRANCH_CHIPS): { shown: string[]; more: number } {
  return { shown: branches.slice(0, max), more: Math.max(0, branches.length - max) };
}

/**
 * El enlace del repo en el navegador, a partir de su remoto. Solo https: un remoto ssh
 * no tiene una página web que abrir, y una URL con usuario o clave no se muestra ni se abre.
 */
export function browserUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname.length < 2) return null;
    return `https://${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

/** Estado de conexión de un repo, para el punto de color de la columna. */
export type RepoStatus = "loading" | "noRemote" | "connected" | "disconnected";

export function repoStatus(target: RepoTarget | null | undefined): RepoStatus {
  if (target === undefined) return "loading";
  if (target === null) return "noRemote";
  return target.account ? "connected" : "disconnected";
}
