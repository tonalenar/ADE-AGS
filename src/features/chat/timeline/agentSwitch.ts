import type { TimelineItem } from "./types";

/**
 * O aviso «agora com Codex» que o app grava no fio quando a conversa troca de agente (backend `conversa/troca.rs`):
 * o código `agentSwitch` e, no texto, um JSON. Puro.
 */
export interface AgentSwitch {
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  model: string | null;
  /** `full`: o agente novo recebeu o resumo da conversa; `delta`: voltou à sessão dele e recebeu só o intervalo. */
  strategy: "full" | "delta";
  /** O acesso pedido não existe no agente novo e virou Supervisionado. */
  accessChanged: boolean;
}

export function agentSwitchOf(item: TimelineItem): AgentSwitch | null {
  if (item.kind !== "notice" || item.label !== "agentSwitch") return null;
  try {
    const raw = JSON.parse(item.text ?? "") as Partial<AgentSwitch>;
    if (typeof raw.from !== "string" || typeof raw.to !== "string") return null;
    return {
      from: raw.from, to: raw.to,
      fromLabel: typeof raw.fromLabel === "string" ? raw.fromLabel : raw.from,
      toLabel: typeof raw.toLabel === "string" ? raw.toLabel : raw.to,
      model: typeof raw.model === "string" ? raw.model : null,
      strategy: raw.strategy === "delta" ? "delta" : "full",
      accessChanged: raw.accessChanged === true,
    };
  } catch {
    return null;
  }
}

export interface Voice {
  id: string;
  label: string;
}

/**
 * Quem falou cada fala do agente numa conversa que trocou de agente: antes da primeira troca, o agente de antes;
 * depois de cada aviso, o novo. Vazio quando nunca trocou (vale o agente da conversa). Puro.
 */
export function voicesByItem(items: TimelineItem[]): Map<string, Voice> {
  const voices = new Map<string, Voice>();
  const first = items.map(agentSwitchOf).find((s) => s !== null);
  if (!first) return voices;
  let current: Voice = { id: first.from, label: first.fromLabel };
  for (const item of items) {
    const change = agentSwitchOf(item);
    if (change) current = { id: change.to, label: change.toLabel };
    else if (item.kind === "assistant") voices.set(item.id, current);
  }
  return voices;
}
