/**
 * A fila persistente das mensagens entre agentes. Ver `src-tauri/src/ipc/commands/peer_queue.rs`
 * (comandos) e `src-tauri/src/peer_queue/store.rs` (estados e ordem).
 */
import { invoke } from "@tauri-apps/api/core";

import type { PeerMessage, QueueCount } from "./types";

/** Evento que o backend emite a cada mudança numa fila (`toTabId` null = todas). */
export const PEER_QUEUE_EVENT = "cc-peer-queue";

export const peerQueueCounts = () => invoke<QueueCount[]>("peer_queue_counts");
export const peerQueueList = (tabId: string) => invoke<PeerMessage[]>("peer_queue_list", { tabId });
export const peerQueueEdit = (id: number, text: string) => invoke<PeerMessage>("peer_queue_edit", { id, text });
/** `delta` −1 sobe, +1 desce. Devolve a fila nova. */
export const peerQueueMove = (id: number, delta: -1 | 1) => invoke<PeerMessage[]>("peer_queue_move", { id, delta });
export const peerQueueCancel = (id: number) => invoke<PeerMessage>("peer_queue_cancel", { id });
export const peerQueueSendNow = (id: number) => invoke<PeerMessage>("peer_queue_send_now", { id });
