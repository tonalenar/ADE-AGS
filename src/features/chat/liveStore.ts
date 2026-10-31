import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { StructuredPhase, StructuredSnapshot } from "@/features/terminal/structuredState";

/**
 * O que o modo chat mostra ao vivo de cada conversa, vindo do canal (`ipc/commands/canal.rs`): a
 * fase (trabalhando ou não), a pergunta em aberto e o diálogo de aprovação na tela. O mapa do
 * `structuredState` não avisa ninguém quando muda; este store sim, para a sidebar e o composer.
 */
export interface TabTurn {
  startedAt: number | null;
  endedAt: number | null;
  /** As ferramentas pendentes do turno (nome e resumo), na ordem. */
  tools: { name: string; summary: string }[];
}

interface LiveState {
  phase: Record<string, StructuredPhase>;
  question: Record<string, boolean>;
  /** A TUI está mostrando um diálogo de aprovação: o resumo da ferramenta. */
  awaiting: Record<string, string>;
  /** O turno de cada aba pelo canal: começo, fim e ferramentas pendentes (a sidebar e a linha viva). */
  turn: Record<string, TabTurn>;
}

export const useChatLive = create<LiveState>(() => ({ phase: {}, question: {}, awaiting: {}, turn: {} }));

type StateEvent = StructuredSnapshot | { tabId: string; removed: true };

/** Aplica um estado do canal. Pura no estado recebido (exportada para os testes). */
export function applyLiveState(state: LiveState, event: StateEvent): LiveState {
  const phase = { ...state.phase };
  const question = { ...state.question };
  const turn = { ...state.turn };
  if ("removed" in event) {
    delete phase[event.tabId];
    delete question[event.tabId];
    delete turn[event.tabId];
  } else {
    phase[event.tabId] = event.phase;
    question[event.tabId] = event.question !== null;
    turn[event.tabId] = {
      startedAt: event.turnStartedAt ?? null,
      endedAt: event.turnEndedAt ?? null,
      tools: (event.tools ?? []).map((t) => ({ name: t.name, summary: t.summary })),
    };
  }
  return { ...state, phase, question, turn };
}

export function applyApproval(state: LiveState, event: { tabId: string; waiting: boolean; tool: string }): LiveState {
  const awaiting = { ...state.awaiting };
  if (event.waiting) awaiting[event.tabId] = event.tool;
  else delete awaiting[event.tabId];
  return { ...state, awaiting };
}

let started = false;

/** Começa a ouvir o backend (uma vez por janela). Sem Tauri (testes), não faz nada. */
export function startChatLive(): void {
  if (started) return;
  started = true;
  try {
    invoke<StructuredSnapshot[]>("structured_state_all")
      .then((all) => useChatLive.setState((s) => all.reduce(applyLiveState, s)))
      .catch(() => undefined);
    listen<StateEvent>("cc-structured-state", (e) => useChatLive.setState((s) => applyLiveState(s, e.payload))).catch(() => undefined);
    listen<{ tabId: string; waiting: boolean; tool: string }>("cc-conversation-approval", (e) =>
      useChatLive.setState((s) => applyApproval(s, e.payload))).catch(() => undefined);
  } catch {
    // fora do app
  }
}
