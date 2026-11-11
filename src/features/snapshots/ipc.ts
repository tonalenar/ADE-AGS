/** A galeria de SnapShots: os comandos `snapshot_gallery_*` de `src-tauri/src/snapshot_gallery/commands.rs`. */
import { invoke } from "@tauri-apps/api/core";

/** Uma captura da pasta de capturas, com a legenda do JSON ao lado quando existe. */
export interface SnapshotItem {
  /** O nome do PNG sem extensão: é o que a galeria manda de volta para copiar ou apagar. */
  id: string;
  /** O caminho absoluto do PNG (miniatura e anexo). */
  path: string;
  app: string | null;
  title: string | null;
  /** `display` ou `window`. */
  scope: string | null;
  /** O instante da captura, como está no JSON. */
  capturedAt: string | null;
  /** Milissegundos desde a época Unix, da última gravação do PNG. */
  modifiedMs: number;
  bytes: number;
}

export const snapshotGalleryList = () => invoke<SnapshotItem[]>("snapshot_gallery_list");

export const snapshotGalleryCopy = (id: string) => invoke<void>("snapshot_gallery_copy", { id });

export const snapshotGalleryDelete = (id: string) => invoke<void>("snapshot_gallery_delete", { id });
