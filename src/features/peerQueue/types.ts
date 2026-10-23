/** Espelha `peer_queue::store::PeerMessage` (Rust, camelCase). */
export type PeerMessageState = "queued" | "delivering" | "delivered" | "unconfirmed" | "cancelled" | "expired";

export type PeerMessageKind = "tell" | "ask" | "handoff" | "role" | "notice";

export interface PeerMessage {
  id: number;
  clientId: string | null;
  kind: PeerMessageKind | string;
  fromTabId: string;
  fromName: string;
  toTabId: string;
  toName: string;
  text: string;
  raw: boolean;
  reply: boolean;
  state: PeerMessageState;
  position: number;
  forceNow: boolean;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  editedAt: number | null;
  note: string | null;
}

export interface QueueCount {
  tabId: string;
  count: number;
}
