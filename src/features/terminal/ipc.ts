/** Comandos del PTY. Ver `terminal/pty_manager.rs`. */
import { invoke } from "@tauri-apps/api/core";

export interface PtyCreateArgs {
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  /** Variables extra para ESTE proceso; `null` = ninguna (ver `pty_create` en Rust). */
  env: Record<string, string> | null;
  /** Comandos ya resueltos a ejecutar antes del agente. */
  prelaunch: string[];
}

/** Lanza el proceso y devuelve el id del PTY. El tamaño se fija acá, al nacer. */
export const ptyCreate = (args: PtyCreateArgs) => invoke<number>("pty_create", { ...args });

/** Scrollback acumulado de un PTY vivo — reconectarse a él no lo reinicia. */
export const ptyAttach = (id: number) => invoke<string>("pty_attach", { id });

/** Bytes escritos desde que arrancó el PTY, sin copiar el scrollback. `null` = ya no existe. */
export const ptyOutputTotal = (id: number) => invoke<number | null>("pty_output_total", { id });

/** El terminal vivo de una tab (el más nuevo), o `null`: para reconectarse tras recargar la ventana. */
export const ptyForTab = (tabId: string) => invoke<number | null>("pty_for_tab", { tabId });

export const ptyWrite = (id: number, data: string) => invoke<void>("pty_write", { id, data });

export const ptyResize = (id: number, cols: number, rows: number) =>
  invoke<void>("pty_resize", { id, cols, rows });

export const ptyKill = (id: number) => invoke<void>("pty_kill", { id });

/** Guarda una imagen pegada en la carpeta temporal de la app y devuelve su ruta. */
export const savePastedImage = (bytes: Uint8Array, mime: string) =>
  invoke<string>("save_pasted_image", bytes, { headers: { "x-mime": mime } });
