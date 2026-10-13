/**
 * Checkpoints das conversas: enquanto as abas estão vivas, o app grava (em `session_history`) a última atividade,
 * uma prévia da tela e a posição no canvas, para que nada dependa de fechar a aba (um travamento não perde a
 * conversa). Lógica pura aqui; o gancho que dispara é `useSessionCheckpoints`.
 */
import { invoke } from "@tauri-apps/api/core";

import type { Box } from "@/features/canvas/geometry";
import { SHELL_AGENT_ID } from "@/features/tabs/types";

/** De quanto em quanto tempo se grava. */
export const CHECKPOINT_MS = 180_000;
/** Linhas e caracteres da prévia da tela: o bastante para reconhecer a conversa na lista. */
export const PREVIEW_LINES = 12;
export const PREVIEW_CHARS = 1500;

export interface CheckpointExtra {
  tabId: string;
  preview: string | null;
  box: Box | null;
}

/** A prévia a partir das linhas da tela: sem linhas vazias, sem controle, só o final. Nula quando não há texto. Pura. */
export function previewFromLines(lines: string[] | null | undefined): string | null {
  if (!lines) return null;
  const clean = lines
    // eslint-disable-next-line no-control-regex
    .map((line) => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trimEnd())
    .filter((line) => line.trim() !== "");
  if (clean.length === 0) return null;
  const text = clean.slice(-PREVIEW_LINES).join("\n");
  return text.length > PREVIEW_CHARS ? text.slice(text.length - PREVIEW_CHARS) : text;
}

interface TabLike {
  id: string;
  agentId: string;
  cwd: string;
  sessionId?: string;
}

/**
 * Uma entrada por aba de agente com a SESSÃO já identificada (o shell puro não é conversa). Sem o id da sessão,
 * duas abas do mesmo agente na mesma pasta cairiam na mesma linha do histórico; elas continuam sendo arquivadas
 * ao fechar. `screen` e `boxOf` são injetados. Pura.
 */
export function buildExtras(
  tabs: TabLike[],
  screen: (tabId: string) => string[] | null,
  boxOf: (tab: TabLike) => Box | null,
): CheckpointExtra[] {
  return tabs
    .filter((tab) => tab.agentId !== SHELL_AGENT_ID && tab.cwd && tab.sessionId)
    .map((tab) => ({ tabId: tab.id, preview: previewFromLines(screen(tab.id)), box: boxOf(tab) }));
}

/** Manda os checkpoints ao backend; devolve quantas entradas foram gravadas. */
export const sendCheckpoints = (workspaceId: string, extras: CheckpointExtra[]) =>
  invoke<number>("db_checkpoint_sessions", { workspaceId, extras });
