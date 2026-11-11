/** As páginas HTML que os agentes publicam: os comandos `render_*` de `src-tauri/src/renders/commands.rs`. */
import { invoke } from "@tauri-apps/api/core";

/** Os metadados de uma página (o HTML fica no backend até a tela pedir). */
export interface RenderPage {
  id: string;
  title: string;
  /** A aba que publicou (vazio se não se sabe). */
  owner: string;
  /** A pasta do projeto da aba que publicou. */
  cwd: string;
  /** Milissegundos desde a época Unix. */
  createdAt: number;
  bytes: number;
}

export const renderList = () => invoke<RenderPage[]>("render_list");

export const renderRead = (id: string) => invoke<string>("render_read", { id });

export const renderDelete = (id: string) => invoke<void>("render_delete", { id });

export const renderOpenExternal = (id: string) => invoke<void>("render_open_external", { id });
