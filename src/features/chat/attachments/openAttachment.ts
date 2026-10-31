import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { useViewTabsStore } from "@/features/tabs/viewStore";

import { addSurface } from "../store";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** O arquivo está dentro da pasta da conversa (então o painel de Arquivos o abre)? Pura. */
export function insideCwd(cwd: string | null, path: string): boolean {
  if (!cwd) return false;
  const base = norm(cwd);
  return norm(path).startsWith(`${base}/`);
}

/**
 * Abrir um anexo que não é imagem: dentro da pasta da conversa, na superfície Arquivos do painel; fora
 * dela (ou uma pasta), revela no Finder. Nunca lê o conteúdo.
 */
export function openAttachment(path: string, kind: "file" | "folder" | "image", cwd: string | null): void {
  if (kind === "file" && cwd && insideCwd(cwd, path)) {
    addSurface("files");
    useViewTabsStore.getState().openFile(cwd, path);
    return;
  }
  revealItemInDir(path).catch(console.error);
}
