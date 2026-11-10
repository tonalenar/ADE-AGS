/**
 * "Armado" não sobrevive ao reinício (`src-tauri/src/missions/automation.rs`). O que foi armado antes de
 * o app abrir (uma missão em andamento, um time de conversa com tarefa delegada, uma rotina a recuperar)
 * fica pausado até a pessoa apertar "Retomar automação". O que nasce depois do boot roda normal.
 *
 * Antes de o estado chegar do backend, tudo de antes de agora conta como pausado (falha fechada): o Vigia
 * não cutuca ninguém nos primeiros segundos de um app recém-aberto.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

export interface AutomationStatus {
  paused: boolean;
  bootMs: number;
  resumedAt: number | null;
  missions: { id: string; title: string }[];
  routines: { id: string; name: string }[];
  /** Tarefas que estavam ativas antes do último boot e seguem pausadas. */
  scheduledTasks?: { id: string; name: string }[];
  interruptedFixRounds: number;
}

export const automationStatus = () => invoke<AutomationStatus>("automation_status");
export const automationResume = () => invoke<AutomationStatus>("automation_resume");

export interface AutomationState {
  status: AutomationStatus | null;
  /** O backend não respondeu (versão sem o comando): nada fica pausado. */
  failed: boolean;
  /** Os times que o Vigia deixou de supervisionar por causa do reinício (id → nome), para a tela. */
  vigia: Record<string, string>;
}

export const useAutomation = create<AutomationState>(() => ({ status: null, failed: false, vigia: {} }));

/** Quando este front subiu: o limite enquanto o backend não responde. */
const LOADED_AT = Date.now();

/** Algo armado em `armedAtMs` está pausado pelo reinício? Pura. */
export function pausedByRestart(armedAtMs: number, status: AutomationStatus | null, failed: boolean, now = LOADED_AT): boolean {
  if (failed) return false;
  if (!status) return armedAtMs < now;
  return status.resumedAt === null && armedAtMs < status.bootMs;
}

let started = false;

export function loadAutomation(): Promise<void> {
  return automationStatus()
    .then((status) => useAutomation.setState({ status, failed: false }))
    .catch(() => useAutomation.setState({ failed: true }));
}

/** Carrega uma vez e acompanha o evento de mudança (o botão some em todas as telas). */
export function ensureAutomation(): void {
  if (started) return;
  started = true;
  void loadAutomation();
  listen("cc-automation-changed", () => void loadAutomation()).catch(() => {});
}

/** O mesmo que `pausedByRestart`, com o estado atual da store. */
export function automationPausedFor(armedAtMs: number): boolean {
  ensureAutomation();
  const { status, failed } = useAutomation.getState();
  return pausedByRestart(armedAtMs, status, failed);
}

/** O Vigia pulou este time por causa do reinício: a tela mostra o botão mesmo sem nada no backend. */
export function notePausedTeam(id: string, title: string): void {
  if (useAutomation.getState().vigia[id] === title) return;
  useAutomation.setState((s) => ({ vigia: { ...s.vigia, [id]: title } }));
}

/** Há o que retomar: algo do backend ou um time que o Vigia pulou. Pura. */
export function hasPaused(state: AutomationState): boolean {
  if (state.failed || state.status?.resumedAt) return false;
  return !!state.status?.paused || Object.keys(state.vigia).length > 0;
}

/** O botão: só a pessoa, pela tela. */
export async function resumeAutomation(): Promise<void> {
  const status = await automationResume();
  useAutomation.setState({ status, failed: false, vigia: {} });
}
