/** Comandos del PTY. Ver `terminal/pty_manager.rs`. */
import { invoke } from "@tauri-apps/api/core";

export interface PtyCreateArgs {
  command: string;
  cwd: string;
  /** Provedor escolhido para esta aba, validado contra a política local do projeto. */
  agentId?: string;
  /** ID da conta local; credenciais e perfil são resolvidos no backend, nunca no WebView. */
  accountId?: string;
  cols: number;
  rows: number;
  /** Overrides posteriores à conta; `null` = nenhum (ver `pty_create` em Rust). */
  env: Record<string, string> | null;
  /** Variáveis da TUI custom/MCP que precedem a conta na ordem de merge. */
  envBeforeAccount?: Record<string, string> | null;
  /** Comandos ya resueltos a ejecutar antes del agente. */
  prelaunch: string[];
  /** Argumentos MCP de sessão, aplicados pelo backend sem passar por shell. */
  extraArgs?: string[];
  /** Somente para uma nova aba, após confirmação do preview. */
  aiMemoryContinuity?: boolean;
  /** Integrante de missão que pediu: o ambiente herdado perde as credenciais de outros serviços
   *  (ver `runs/sandbox.rs`). Ausente = aba da pessoa, como sempre. */
  scrubSecrets?: boolean;
}

/** Lanza el proceso y devuelve el id del PTY. El tamaño se fija acá, al nacer. */
export const ptyCreate = (args: PtyCreateArgs) => invoke<number>("pty_create", { ...args });

/** Scrollback acumulado de un PTY vivo — reconectarse a él no lo reinicia. */
export const ptyAttach = (id: number) => invoke<string>("pty_attach", { id });
/** O scrollback do PTY e o ponto do fluxo (`end` dos eventos) em que foi tirado. */
export const ptySnapshot = (id: number) => invoke<{ data: string; total: number }>("pty_snapshot", { id });

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
