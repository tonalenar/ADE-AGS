/**
 * Quantas mensagens de agentes esperam cada aba. O backend avisa cada mudança com
 * `cc-peer-queue`; aqui só se guarda a contagem (o selo) e um número de versão que as listas
 * abertas usam para se recarregar.
 */
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import { PEER_QUEUE_EVENT, peerQueueCounts } from "./ipc";
import { countsToMap, sameCounts } from "./model";

interface PeerQueueState {
  /** aba → quantas esperam (ausente = nenhuma). */
  counts: Record<string, number>;
  /** Sobe a cada aviso do backend: a lista aberta se recarrega. */
  version: number;
}

export const usePeerQueueStore = create<PeerQueueState>(() => ({ counts: {}, version: 0 }));

let started = false;
let inflight = false;
let again = false;

/** Relê as contagens. Um pedido no meio de outro vira um só a mais, no fim. */
export function refreshPeerQueueCounts(): void {
  if (inflight) {
    again = true;
    return;
  }
  inflight = true;
  peerQueueCounts()
    .then((list) => {
      const next = countsToMap(list);
      if (!sameCounts(usePeerQueueStore.getState().counts, next)) usePeerQueueStore.setState({ counts: next });
    })
    .catch(() => {})
    .finally(() => {
      inflight = false;
      if (again) {
        again = false;
        refreshPeerQueueCounts();
      }
    });
}

/** Liga a escuta uma vez por janela (o primeiro selo que monta liga). */
export function ensurePeerQueueSync(): void {
  if (started) return;
  started = true;
  refreshPeerQueueCounts();
  try {
    void listen(PEER_QUEUE_EVENT, () => {
      usePeerQueueStore.setState((s) => ({ version: s.version + 1 }));
      refreshPeerQueueCounts();
    }).catch(() => {});
  } catch {
    /* fora do Tauri (testes): sem eventos */
  }
  // Rede de segurança: um aviso perdido não deixa o selo errado para sempre.
  window.setInterval(refreshPeerQueueCounts, 30_000);
}
