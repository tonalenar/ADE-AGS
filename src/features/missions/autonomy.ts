/**
 * Cuántos permisos piden los agentes de una misión en terminales.
 *
 * - `ask`: como cada CLI viene de fábrica (pide casi todo).
 * - `safe`: **automático con protección**. Cada CLI aprueba por su cuenta lo rutinario SIN
 *   quitar su sandbox ni saltarse los permisos: Codex con revisión automática dentro del
 *   sandbox, Antigravity y Gemini aprobando solo las ediciones. Nunca usa los modos
 *   "peligrosos" (`--dangerously-*`, `--yolo`): esos no existen en esta app.
 */
export type Autonomy = "ask" | "safe";

export const DEFAULT_AUTONOMY: Autonomy = "safe";
const STORAGE_KEY = "ags.agentAutonomy";

/** Lo que cada agente recibe en el nivel `safe`. Verificado con `--help` de cada CLI. */
const SAFE_FLAGS: Record<string, string> = {
  codex: "--approve-for-me",
  antigravity: "--mode accept-edits",
  "gemini-cli": "--approval-mode auto_edit",
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
