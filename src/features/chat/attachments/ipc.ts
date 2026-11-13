import { invoke } from "@tauri-apps/api/core";

import type { AttachmentKind } from "./attachModel";

/** Espelho de `conversa::attach::Inspected`: o que há num caminho (só `stat`, nada é lido). */
export interface Inspected {
  path: string;
  name: string;
  kind: AttachmentKind;
  mime: string | null;
  size: number | null;
  error: string | null;
}

export const inspectPaths = (paths: string[]) => invoke<Inspected[]>("chat_attachment_inspect", { paths });

/** Uma imagem de um caminho que a pessoa anexou, como URL de dados (miniatura e visualizador). */
export const readImage = (path: string) => invoke<{ mime: string; dataUrl: string }>("chat_attachment_read", { path });

/** Remove o fundo localmente pelo Vision no macOS quando o helper está empacotado. */
export const backgroundRemovalAvailable = () => invoke<boolean>("chat_attachment_remove_background_available");
export const removeImageBackground = (path: string) => invoke<string>("chat_attachment_remove_background", { path });

/** Grava a cópia anotada (PNG em base64, sem o prefixo `data:`) ao lado do original; devolve o caminho novo. */
export const saveAnnotatedCopy = (path: string, pngBase64: string) => invoke<string>("chat_attachment_save_annotated", { path, pngBase64 });
