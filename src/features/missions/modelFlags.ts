/**
 * El modelo y el esfuerzo que el Squad eligió para cada integrante, como flags del CLI.
 *
 * Sin esto, un terminal de misión arrancaba con el modelo por defecto de cada TUI y el
 * Squad ("Sol 6.1, medio") se ignoraba. Los flags salen de `--help` de cada CLI:
 * Codex `-m` y `-c model_reasoning_effort=…`; Antigravity `--model` y `--effort`; Claude
 * Code `--model` y `--effort`. Otros agentes no reciben nada.
 */

/** Ids de modelo y niveles de esfuerzo seguros para ir en una línea de comando. */
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,80}$/;
const SAFE_EFFORT = /^[a-z]{2,12}$/;

const MODEL_FLAG: Record<string, string> = {
  codex: "-m",
  antigravity: "--model",
  "claude-code": "--model",
  "gemini-cli": "-m",
};

/**
 * Modo Fast de Codex: `service_tier` es la clave de config de la CLI (`codex -c service_tier=…`;
 * el valor "fast" es el que graba la propia app de Codex y el catálogo lo declara por modelo en
 * `additional_speed_tiers`). Valor fijo: nunca sale de texto libre, así no hay forma de colar un flag.
 */
const CODEX_FAST_FLAGS = ["-c", "service_tier=fast"];

/** El comando con el modelo, el esfuerzo y (solo Codex) el modo Fast pedidos. No repite lo que ya trae. Pura. */
export function withModel(
  agentId: string,
  command: string,
  model?: string | null,
  effort?: string | null,
  fast?: boolean | null,
): string {
  const parts = [command];
  const modelFlag = MODEL_FLAG[agentId];
  const cleanModel = model?.trim();
  if (modelFlag && cleanModel && SAFE_MODEL.test(cleanModel) && !hasFlag(command, modelFlag)) {
    parts.push(modelFlag, cleanModel);
  }
  const cleanEffort = effort?.trim().toLowerCase();
  if (cleanEffort && SAFE_EFFORT.test(cleanEffort)) {
    if (agentId === "codex" && !command.includes("model_reasoning_effort")) {
      parts.push("-c", `model_reasoning_effort=${cleanEffort}`);
    } else if ((agentId === "antigravity" || agentId === "claude-code") && !hasFlag(command, "--effort")) {
      parts.push("--effort", cleanEffort);
    }
  }
  if (fast === true && agentId === "codex" && !command.includes("service_tier")) {
    parts.push(...CODEX_FAST_FLAGS);
  }
  return parts.join(" ");
}

function hasFlag(command: string, flag: string): boolean {
  return command.split(/\s+/).includes(flag);
}
