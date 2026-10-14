import { withModel } from "@/features/missions/modelFlags";

/**
 * O esforço, o modelo e o modo Fast de um terminal já aberto. Ficam NA LINHA DE COMANDO da aba (é assim que o
 * agente arranca: `codex … -m X -c model_reasoning_effort=high`), então para ler e para mudar basta trabalhar o
 * comando. Mudar vale na próxima partida do agente: o app reinicia e retoma a mesma conversa (`--resume`).
 */
export interface TabTuning {
  model: string | null;
  effort: string | null;
  fast: boolean;
}

const MODEL_FLAGS = new Set(["--model", "-m"]);

const tokens = (command: string) => command.trim().split(/\s+/).filter(Boolean);

/** Lê o que o comando da aba já fixa. Pura. */
export function readTuning(agentId: string, command: string): TabTuning {
  const parts = tokens(command);
  let model: string | null = null;
  let effort: string | null = null;
  let fast = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const next = parts[i + 1];
    if (MODEL_FLAGS.has(part) && next) model = next;
    if (part === "--effort" && next) effort = next;
    if (part === "-c" && next) {
      if (next.startsWith("model_reasoning_effort=")) effort = next.slice("model_reasoning_effort=".length);
      if (next === "service_tier=fast") fast = true;
    }
  }
  return { model, effort, fast: agentId === "codex" && fast };
}

/** Tira do comando os flags de esforço e de Fast (e só eles), sem mexer em mais nada. Pura. */
function withoutTuning(command: string): string {
  const parts = tokens(command);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const next = parts[i + 1];
    if (part === "--effort" && next) { i += 1; continue; }
    if (part === "-c" && next && /^(model_reasoning_effort|service_tier|features\.fast_mode)=/.test(next)) { i += 1; continue; }
    out.push(part);
  }
  return out.join(" ");
}

/**
 * O comando com o esforço e o Fast novos. `effort: null` deixa o esforço padrão do agente; `fast` só vale no Codex
 * (os outros agentes ignoram). Mantém o modelo e todo o resto do comando. Pura.
 */
export function retune(agentId: string, command: string, change: { effort: string | null; fast: boolean }): string {
  return withModel(agentId, withoutTuning(command), null, change.effort, change.fast);
}

/** Os níveis de esforço quando o catálogo do agente não informa (os mesmos que as CLIs aceitam). */
export const DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Esforço e Fast mudam para valer? (compara com o que o comando já fixa). Pura. */
export function tuningChanged(before: TabTuning, effort: string | null, fast: boolean): boolean {
  return (before.effort ?? null) !== (effort ?? null) || before.fast !== fast;
}
