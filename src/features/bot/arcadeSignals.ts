import { create } from "zustand";

/**
 * Sinais reais, por terminal, com que o Ao vivo deriva andar e entrega quando a missão roda em
 * terminais (sem tasks). Vivem fora do componente para não perder o histórico com o QG fechado;
 * quem alimenta é o `useMissionWatcher` (sempre montado). Só memória desta sessão: nada é inventado.
 */
interface SignalsState {
  /** Terminais que já escreveram de forma sustentada alguma vez: saíram da Abertura (briefing/espera). */
  worked: Record<string, true>;
  /** Entregas finais (peer tell de encerramento) por terminal, na ordem em que chegaram. */
  deliveries: Record<string, number[]>;
}

export const useArcadeSignals = create<SignalsState>(() => ({ worked: {}, deliveries: {} }));

/** Marca terminais com saída sustentada. Só reescreve o estado quando há novidade. */
export function noteSustained(tabIds: readonly string[]): void {
  const { worked } = useArcadeSignals.getState();
  const fresh = tabIds.filter((id) => !worked[id]);
  if (!fresh.length) return;
  useArcadeSignals.setState({ worked: { ...worked, ...Object.fromEntries(fresh.map((id) => [id, true as const])) } });
}

export function noteDelivery(tabId: string, atMs: number): void {
  const { deliveries } = useArcadeSignals.getState();
  useArcadeSignals.setState({ deliveries: { ...deliveries, [tabId]: [...(deliveries[tabId] ?? []), atMs] } });
}

export interface DeliveryMessage {
  kind: string;
  fromTabId: string;
  toTabId: string | null;
  text?: string | null;
}

/**
 * ¿É a "entrega final" de um integrante? Um `peer tell` de um integrante ao orquestrador com o
 * formato que o briefing pede (resultado + testes). Um "ok" ou uma pergunta não conta. Pura.
 */
export function isFinalDelivery(msg: DeliveryMessage, isLead: (tabId: string) => boolean): boolean {
  if (msg.kind !== "tell" || !msg.toTabId || !isLead(msg.toTabId) || isLead(msg.fromTabId)) return false;
  const text = (msg.text ?? "").toLowerCase();
  return /resultado|result\b|resultados|resultado:/.test(text) && /teste|test/.test(text);
}
