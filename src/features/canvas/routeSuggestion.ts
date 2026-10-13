/**
 * "Para quem mando isto?": enquanto se escreve na aba Equipe sem @, o Jev SUGERE um destinatário. Só sugere: a
 * pessoa clica no chip (que põe o @Nome no começo) ou ignora. Desligado por padrão (Ajustes > Decisões); com
 * ele desligado o backend devolve nada e nenhum texto sai da máquina. Lógica pura + um gancho fino.
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import type { Addressee } from "./teamFeedModel";

export interface RouteGuess {
  target: string;
  confidence: number | null;
  probability: number | null;
}

/** Só se mostra o que o Jev dá como provável de verdade: probabilidade de pelo menos 0,5 (a confiança não separa certo de errado). */
export const ROUTE_MIN_PROBABILITY = 0.5;
/** Mensagens curtas demais não dizem para quem vão. */
export const ROUTE_MIN_CHARS = 12;
export const ROUTE_DEBOUNCE_MS = 800;

/** Vale pedir uma sugestão para este rascunho? Sem @, com texto suficiente e ao menos dois destinos. Pura. */
export function shouldAsk(draft: string, addressees: Addressee[]): boolean {
  const text = draft.trim();
  return text.length >= ROUTE_MIN_CHARS && !text.startsWith("@") && addressees.length >= 2;
}

/** O destinatário a oferecer: o integrante que o Jev escolheu, se a probabilidade passa do mínimo. O orquestrador (o destino padrão) não precisa de chip. Pura. */
export function offeredTarget(guess: RouteGuess | null, addressees: Addressee[]): Addressee | null {
  if (!guess || (guess.probability !== null && guess.probability < ROUTE_MIN_PROBABILITY)) return null;
  if (/^orquestrador/i.test(guess.target)) return null;
  return addressees.find((a) => a.name.toLowerCase() === guess.target.toLowerCase()) ?? null;
}

/** O rascunho com o destinatário escolhido no começo. Pura. */
export function withTarget(draft: string, target: Addressee): string {
  return `@${target.name} ${draft.trim()}`;
}

/** Pede a sugestão ao backend depois de uma pausa na digitação; devolve o destinatário a oferecer, ou nulo. */
export function useRouteSuggestion(draft: string, addressees: Addressee[], roles: Record<string, string> | undefined, enabled: boolean): Addressee | null {
  const [offer, setOffer] = useState<Addressee | null>(null);
  useEffect(() => {
    setOffer(null);
    if (!enabled || !shouldAsk(draft, addressees)) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      const members = addressees.map((a) => ({ name: a.name, role: roles?.[a.id] || a.name }));
      invoke<RouteGuess | null>("decision_route_turn", { text: draft.trim(), members, local: null })
        .then((guess) => { if (alive) setOffer(offeredTarget(guess ?? null, addressees)); })
        .catch(() => undefined);
    }, ROUTE_DEBOUNCE_MS);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [draft, addressees, roles, enabled]);
  return offer;
}
