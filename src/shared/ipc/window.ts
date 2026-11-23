/**
 * Comandos de ventana y de la app, los únicos que no pertenecen a ninguna feature.
 * Ver `window/manager.rs`.
 */
import { invoke } from "@tauri-apps/api/core";

export const homeDir = () => invoke<string>("get_home_dir");

export const focusWindow = (label: string) => invoke<void>("focus_window", { label });

/**
 * Cierra ESTA ventana. Si quedan otras del mismo workspace, su fila se borra; si era la
 * última, se preserva para poder restaurar el workspace.
 */
export const closeAndForgetWindow = (label: string) =>
  invoke<void>("close_and_forget_window", { label });

/** Confirma la salida de la app entera tras el diálogo de "hay varias ventanas abiertas". */
export const confirmExitAll = () => invoke<void>("confirm_exit_all");

/** Emite un evento a TODAS las ventanas (incluida la que llama). */
export const broadcastEvent = (event: string, payload: string) =>
  invoke<void>("broadcast_event", { event, payload });

/** Fecha a janela depois de salvar tudo (`close_window_saved`). */
export const closeWindowSaved = (label: string) => invoke<void>("close_window_saved", { label });

/** Reinicia a app para aplicar a atualização baixada. */
export const updateRestart = () => invoke<void>("update_restart");

/** Reposiciona os botões nativos do macOS sobre o lugar reservado na interface. */
export const windowControlsPlace = (place: { x: number; y: number; visible: boolean }) =>
  invoke<void>("window_controls_place", place);

/** Em que fase está a abertura do banco (`db_boot_status`). */
export const dbBootStatus = () => invoke<{ phase: string }>("db_boot_status");

/** Os sites do navegador com mudanças sem gravar, e a gravação de um deles. */
export const previewUnsavedSites = () => invoke<string[]>("preview_unsaved_sites");

export const previewSaveSite = (origin: string) => invoke<void>("preview_save_site", { origin });
