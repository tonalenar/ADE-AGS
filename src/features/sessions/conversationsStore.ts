import { create } from "zustand";

import { comparablePath } from "@/features/tabs/viewTabs";

import type { ConversationRow } from "./conversationModel";
import { listConversations } from "./ipc.projectConversations";

interface ConversationsState {
  rows: ConversationRow[];
  loading: boolean;
  error: string | null;
  load: (workspaceId: string) => Promise<void>;
  /** Troca uma linha pela devolvida pelo backend (ou a acrescenta). */
  upsert: (row: ConversationRow) => void;
  remove: (id: string) => void;
}

export const useConversationsStore = create<ConversationsState>((set) => ({
  rows: [],
  loading: false,
  error: null,
  load: async (workspaceId) => {
    set({ loading: true, error: null });
    try {
      set({ rows: await listConversations(workspaceId) });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ loading: false });
    }
  },
  upsert: (row) => set((s) => ({ rows: s.rows.some((r) => r.id === row.id) ? s.rows.map((r) => (r.id === row.id ? row : r)) : [row, ...s.rows] })),
  remove: (id) => set((s) => ({ rows: s.rows.filter((r) => r.id !== id) })),
}));

const norm = (path: string) => comparablePath(path).replace(/\/+$/, "").toLowerCase();

/** A pasta está dentro (ou é) a da conversa? Pura. */
export function cwdBelongsTo(cwd: string, base: string): boolean {
  const here = norm(cwd);
  const root = norm(base);
  return here === root || here.startsWith(`${root}/`);
}

/** A conversa ATIVA que recebe o que se abre na pasta `cwd`, se houver (a mais específica). Pura. */
export function activeConversationFor(rows: ConversationRow[], cwd: string): ConversationRow | null {
  const mine = rows.filter((r) => r.state === "active" && cwdBelongsTo(cwd, r.cwd));
  return mine.sort((a, b) => norm(b.cwd).length - norm(a.cwd).length)[0] ?? null;
}
