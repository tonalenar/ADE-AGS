/**
 * Estado e fila de espera orientada a eventos para handoffs de captcha.
 *
 * Sem polling: cada chamada de `waitForCaptchaHandoff` registra um ouvinte por id e um
 * único timer de prazo. Quando a página sai do desafio (navegação ou mutação do DOM) ou a
 * pessoa clica em "Cancelar", o ouvinte é acordado na hora.
 */
import { create } from "zustand";

import type { ViewOwner } from "@/features/tabs/viewTabs";
import type { CaptchaKind } from "./captcha";

export interface CaptchaHandoff {
  id: string;
  viewId: string;
  kind: CaptchaKind;
  since: number;
  url: string;
  site: string;
  agentName: string;
  cwd: string;
  owner: ViewOwner | null;
  portalId?: string;
}

export type CaptchaWaitResult =
  | { resolved: true }
  | { expired: true }
  | { cancelled: true };

interface CaptchaStoreState {
  handoffs: Record<string, CaptchaHandoff>;
}

export const useCaptchaStore = create<CaptchaStoreState>(() => ({
  handoffs: {},
}));

type Waiter = (result: CaptchaWaitResult) => void;

const waiters = new Map<string, Set<Waiter>>();
const settledOutcomes = new Map<string, CaptchaWaitResult>();
const MAX_SETTLED_HISTORY = 100;

function rememberOutcome(id: string, outcome: CaptchaWaitResult): void {
  settledOutcomes.set(id, outcome);
  if (settledOutcomes.size > MAX_SETTLED_HISTORY) {
    const oldest = settledOutcomes.keys().next().value;
    if (oldest !== undefined) settledOutcomes.delete(oldest);
  }
}

function notifyWaiters(id: string, outcome: CaptchaWaitResult): void {
  rememberOutcome(id, outcome);
  const listeners = waiters.get(id);
  if (!listeners) return;
  waiters.delete(id);
  for (const wake of listeners) wake(outcome);
}

/** Extrai o host legível de uma URL para exibir no cartão e no aviso do sistema. */
export function siteLabelOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "site";
  }
}

export interface OpenHandoffInput {
  id?: string;
  viewId: string;
  kind: CaptchaKind;
  since?: number;
  url: string;
  agentName: string;
  cwd: string;
  owner: ViewOwner | null;
  portalId?: string;
}

/**
 * Registra (ou reaproveita) o handoff de captcha ativo para uma vista de navegador.
 * Retorna o handoff e se ele acabou de ser criado (`created: true`).
 */
export function openCaptchaHandoff(input: OpenHandoffInput): { handoff: CaptchaHandoff; created: boolean } {
  const existing = useCaptchaStore.getState().handoffs[input.viewId];
  if (existing && existing.kind === input.kind) {
    const nextUrl = input.url || existing.url;
    if (nextUrl !== existing.url) {
      const updated: CaptchaHandoff = { ...existing, url: nextUrl, site: siteLabelOf(nextUrl) };
      useCaptchaStore.setState((s) => ({ handoffs: { ...s.handoffs, [input.viewId]: updated } }));
      return { handoff: updated, created: false };
    }
    return { handoff: existing, created: false };
  }

  const handoff: CaptchaHandoff = {
    id: input.id ?? `cap-${crypto.randomUUID().slice(0, 8)}`,
    viewId: input.viewId,
    kind: input.kind,
    since: input.since ?? Date.now(),
    url: input.url,
    site: siteLabelOf(input.url),
    agentName: input.agentName,
    cwd: input.cwd,
    owner: input.owner,
    portalId: input.portalId,
  };
  useCaptchaStore.setState((s) => ({
    handoffs: { ...s.handoffs, [input.viewId]: handoff },
  }));
  return { handoff, created: true };
}

export function getCaptchaHandoffForView(viewId: string): CaptchaHandoff | null {
  return useCaptchaStore.getState().handoffs[viewId] ?? null;
}

export function getCaptchaHandoffById(handoffId: string): CaptchaHandoff | null {
  const all = useCaptchaStore.getState().handoffs;
  for (const h of Object.values(all)) {
    if (h.id === handoffId) return h;
  }
  return null;
}

/** Remove o handoff e acorda qualquer `browser_wait_human` aguardando por ele com `{ resolved: true }`. */
export function resolveCaptchaHandoff(viewIdOrHandoffId: string): boolean {
  const handoffs = useCaptchaStore.getState().handoffs;
  const target = handoffs[viewIdOrHandoffId] ?? Object.values(handoffs).find((h) => h.id === viewIdOrHandoffId);
  if (!target) return false;
  useCaptchaStore.setState((s) => {
    const next = { ...s.handoffs };
    delete next[target.viewId];
    return { handoffs: next };
  });
  notifyWaiters(target.id, { resolved: true });
  return true;
}

/** Cancela o handoff (botão "Cancelar" no cartão) e acorda quem espera com `{ cancelled: true }`. */
export function cancelCaptchaHandoff(viewIdOrHandoffId: string): boolean {
  const handoffs = useCaptchaStore.getState().handoffs;
  const target = handoffs[viewIdOrHandoffId] ?? Object.values(handoffs).find((h) => h.id === viewIdOrHandoffId);
  if (!target) return false;
  useCaptchaStore.setState((s) => {
    const next = { ...s.handoffs };
    delete next[target.viewId];
    return { handoffs: next };
  });
  notifyWaiters(target.id, { cancelled: true });
  return true;
}

/**
 * Espera por evento até o captcha ser resolvido, cancelado pela pessoa ou expirar.
 * Nunca faz polling: usa um ouvinte e um único `setTimeout` para o prazo.
 */
export function waitForCaptchaHandoff(handoffId: string, timeoutMs: number): Promise<CaptchaWaitResult> {
  const active = getCaptchaHandoffById(handoffId);
  if (!active) {
    const settled = settledOutcomes.get(handoffId);
    if (settled) return Promise.resolve(settled);
    return Promise.reject(new Error(`Nenhum handoff de captcha ativo com id '${handoffId}'.`));
  }

  return new Promise<CaptchaWaitResult>((resolve) => {
    let done = false;
    const finish = (outcome: CaptchaWaitResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const set = waiters.get(handoffId);
      if (set) {
        set.delete(finish);
        if (set.size === 0) waiters.delete(handoffId);
      }
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      const stillActive = getCaptchaHandoffById(handoffId);
      if (stillActive) {
        useCaptchaStore.setState((s) => {
          const next = { ...s.handoffs };
          delete next[stillActive.viewId];
          return { handoffs: next };
        });
        notifyWaiters(handoffId, { expired: true });
      } else {
        finish({ expired: true });
      }
    }, timeoutMs);

    let set = waiters.get(handoffId);
    if (!set) {
      set = new Set();
      waiters.set(handoffId, set);
    }
    set.add(finish);
  });
}

/** Limpa todo o estado de captcha (para testes). */
export function resetCaptchaStore(): void {
  waiters.clear();
  settledOutcomes.clear();
  useCaptchaStore.setState({ handoffs: {} });
}
