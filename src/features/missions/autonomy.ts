/**
 * Cuántos permisos piden los agentes de una misión en terminales.
 *
 * - `ask`: como cada CLI viene de fábrica (pide casi todo).
 * - `safe`: **automático con protección**. Cada CLI aprueba por su cuenta lo rutinario SIN
 *   quitar su sandbox ni saltarse los permisos: Codex con revisión automática dentro del
 *   sandbox, Gemini aprobando solo las ediciones y Claude Code en su modo automático
 *   (`--permission-mode auto`: un clasificador del propio Claude revisa cada acción; no es
 *   `bypassPermissions`). Este nivel no agrega los modos
 *   "peligrosos" (`--dangerously-*`, `--yolo`).
 *   Antigravity NO tiene flag acá a propósito: sus terminales interactivos ya reciben
 *   `--dangerously-skip-permissions` desde el catálogo (`AgentDef::launch_args`), porque hay
 *   alguien mirando la TUI, y sumarle `--mode accept-edits` los dejaba con dos flags de
 *   permisos que se pisan. Los runs de Mission/Fleet no lo reciben: ver `runs/antigravity.rs`.
 */
export type Autonomy = "ask" | "safe";

export const DEFAULT_AUTONOMY: Autonomy = "safe";
const STORAGE_KEY = "ags.agentAutonomy";

/** Lo que cada agente recibe en el nivel `safe`. Verificado con `--help` de cada CLI. */
const SAFE_FLAGS: Record<string, string> = {
  codex: "--approve-for-me",
  "gemini-cli": "--approval-mode auto_edit",
  "claude-code": "--permission-mode auto",
};

/** El comando con los flags del nivel pedido. No repite un flag que ya está. Pura. */
export function withAutonomy(agentId: string, command: string, level: Autonomy): string {
  const flags = level === "safe" ? SAFE_FLAGS[agentId] : undefined;
  if (!flags) return command;
  const first = flags.split(" ")[0];
  return command.includes(first) ? command : `${command} ${flags}`;
}

export function getAutonomy(): Autonomy {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "ask" || value === "safe" ? value : DEFAULT_AUTONOMY;
  } catch {
    return DEFAULT_AUTONOMY;
  }
}

export function setAutonomy(level: Autonomy): void {
  try {
    localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // Sin almacenamiento, vale el valor por defecto.
  }
}
