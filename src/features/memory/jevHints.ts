/**
 * O que o Jev achou de cada proposta, para a tela "Sugestões de memória" MOSTRAR. Nunca aprova nada:
 * a pessoa continua clicando. Lógica pura aqui; a leitura é `decision_memory_hints` (só lê o log).
 */
import { invoke } from "@tauri-apps/api/core";

import { itemId } from "./bulkReview";
import type { MemoryReviewItem } from "./types";

export type HintAction = "aprovar" | "rejeitar" | "revisar";

export interface JevHint {
  index: number;
  provider: string;
  action: HintAction;
  secret: boolean | null;
  confidence: number | null;
  probability: number | null;
}

/**
 * Para a seleção: o rótulo "aprovar" com probabilidade de pelo menos 0.45 (a maioria numa pergunta de 3 opções).
 * No conjunto de rejeição o Jev acertou todos os rótulos, mas sua "confiança" (0.2 a 0.98) não separava o certo
 * do errado, então um piso de 0.85 não deixava passar nenhuma aprovação correta. Quem decide é o rótulo + o
 * filtro de segredo; o clique de confirmar continua sendo da pessoa.
 */
export const HINT_SELECT_MIN_PROBABILITY = 0.45;

/** Pergunta ao backend o que o log já tem sobre estas propostas. Sem Jev configurado, volta vazio. */
export async function fetchHints(items: MemoryReviewItem[]): Promise<Record<string, JevHint>> {
  if (items.length === 0) return {};
  const found = await invoke<JevHint[]>("decision_memory_hints", {
    items: items.map((item) => ({ key: item.key, kind: item.kind, operation: item.operation, body: item.body })),
  });
  const byId: Record<string, JevHint> = {};
  for (const hint of found) {
    const item = items[hint.index];
    if (item) byId[itemId(item)] = hint;
  }
  return byId;
}

/** Os ids que o Jev aprovaria: ação "aprovar", sem suspeita de segredo e (se há probabilidade) acima do mínimo. Pura. */
export function jevApprovedIds(items: MemoryReviewItem[], hints: Record<string, JevHint>): string[] {
  return items
    .map(itemId)
    .filter((id) => {
      const hint = hints[id];
      return !!hint && hint.action === "aprovar" && hint.secret !== true && (hint.probability === null || hint.probability >= HINT_SELECT_MIN_PROBABILITY);
    });
}

/** Dá para parar de consultar: todas as propostas já têm dica. Pura. */
export function allHinted(items: MemoryReviewItem[], hints: Record<string, JevHint>): boolean {
  return items.every((item) => hints[itemId(item)] !== undefined);
}

/** A etiqueta curta de cada dica (a cor é decidida na tela). Pura. */
export function hintTone(hint: JevHint): "approve" | "reject" | "review" {
  return hint.action === "aprovar" ? "approve" : hint.action === "rejeitar" ? "reject" : "review";
}
