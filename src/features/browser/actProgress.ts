/**
 * Progresso parcial do `act` (plano v2, Fase 1.4). Se a janela do app trava no meio de um `act`, o backend desiste da espera e o
 * relatório inteiro se perdia: o agente não sabia o que já foi feito e repetia (duplicando um «adicionar ao carrinho»). Aqui cada
 * ação concluída vira uma linha enviada ao backend, que a anexa ao erro de timeout. Só embrulha as ações: não decide nada.
 */
import { invoke } from "@tauri-apps/api/core";

import type { PilotDeps } from "./jevPilot";

/** Quanto do último snapshot acompanha o progresso (o começo da página basta para o agente se situar). */
export const PROGRESS_SNAPSHOT_CHARS = 1500;

export type ProgressSink = (report: string) => void;

/** O texto que o backend guarda: as ações feitas e o começo da última página lida. */
export function progressReport(actions: string[], lastSnapshot: string): string {
  if (actions.length === 0) return "";
  const head = `Ações já feitas pelo piloto antes da queda (${actions.length}):\n${actions.join("\n")}`;
  const page = lastSnapshot.trim();
  if (!page) return head;
  const clipped = page.length > PROGRESS_SNAPSHOT_CHARS ? `${page.slice(0, PROGRESS_SNAPSHOT_CHARS)}\n…` : page;
  return `${head}\nÚltima página lida pelo piloto (início):\n${clipped}`;
}

/** As mesmas ações do piloto, avisando `sink` a cada ação concluída. Uma falha da ação não conta como feita. */
export function withProgress(deps: PilotDeps, sink: ProgressSink): PilotDeps {
  const actions: string[] = [];
  let snapshot = "";
  const done = (what: string): void => {
    actions.push(`${actions.length + 1}. ${what}`);
    try { sink(progressReport(actions, snapshot)); } catch { /* o progresso é um extra: nunca derruba o act */ }
  };
  const act = <A extends unknown[], R>(label: (...args: A) => string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const result = await fn(...args);
      done(label(...args));
      return result;
    };
  return {
    ...deps,
    snapshot: async () => { snapshot = await deps.snapshot(); return snapshot; },
    click: act((ref) => `clicou ${ref}`, deps.click),
    type: act((ref, text, submit) => `digitou em ${ref} (${text.length} caracteres${submit ? ", com Enter" : ""})`, deps.type),
    select: act((ref, value) => `escolheu «${value.slice(0, 40)}» em ${ref}`, deps.select),
    scroll: act(() => "rolou a página", deps.scroll),
    clickAt: deps.clickAt && act((x, y) => `tocou no ponto ${Math.round(x)},${Math.round(y)} (pela foto)`, deps.clickAt),
  };
}

/** Manda o progresso do portal ao backend (fire-and-forget). */
export function backendSink(portalId: string): ProgressSink {
  return (report) => { invoke("portal_act_progress", { portalId, report }).catch(() => {}); };
}
