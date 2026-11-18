// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@/features/agents/useAvailableAgents", () => ({ useAvailableAgents: () => [] }));
// O rascunho e a conversa da pergunta selecionada são pesados e não entram neste teste.
vi.mock("../SideChatDraft", () => ({ SideChatDraftView: () => null }));
vi.mock("../structured/StructuredConversationView", () => ({ StructuredConversationView: () => null }));
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return { ...actual, conversationTimeline: () => Promise.resolve([]) };
});
vi.mock("../structured/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../structured/ipc")>();
  return { ...actual, chatThreadItems: () => Promise.resolve([]), chatSideChatDelete: () => Promise.resolve(undefined) };
});

import type { ConversationCard } from "../chatModel";
import { SideChatPanel } from "../SideChatPanel";
import { useStructured } from "../structured/store";
import { EMPTY_LIVE } from "../structured/model";
import { useShelf } from "../shelf";

const parent: ConversationCard = {
  tabId: "thread:parent", title: "Conversa", project: "ADE", cwd: "/p/ade", branch: "main", isWorktree: false, agentId: "claude-code", agentLabel: "Claude Code", starting: false, active: false, openedAt: 1,
};
const sideChat = (id: string, updatedAt: number) => ({
  id, isSideChat: true, parentRef: "thread:parent", title: `Pergunta ${id}`, state: "active", updatedAt, agentId: "claude-code", cwd: "/p/ade", model: null, effort: null, access: "ask", accountId: null, createdAt: 1, forkMode: null, forkReason: null, branch: "main",
}) as never;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useShelf.setState({ snoozed: [], settled: [], pinned: [] });
  useStructured.setState({ threads: [sideChat("a", 2), sideChat("b", 1)], live: { a: { ...EMPTY_LIVE }, b: { ...EMPTY_LIVE } }, hydrated: {}, hydrateErrors: {}, goals: {}, goalNotices: {}, logFailures: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

// Os botões Apagar das linhas (a barra de perguntas laterais), na ordem da lista.
const rowDeletes = () => [...host.querySelectorAll<HTMLButtonElement>("nav button[aria-label='chat.sideChat.delete']")];

describe("o Apagar de cada pergunta lateral reflete a fase dela", () => {
  it("outra_conversa_muda_de_fase_e_o_apagar_reflete: a pergunta B começa a trabalhar e o Apagar dela desabilita, sem ser a selecionada", async () => {
    await act(async () => { root.render(<SideChatPanel conversation={parent} cards={[]} />); });
    expect(rowDeletes()).toHaveLength(2);
    // A linha B é a segunda na lista (a mais recente é a A). Nenhuma das duas está em trabalho.
    expect(rowDeletes()[1]!.disabled).toBe(false);

    await act(async () => {
      useStructured.setState((s) => ({ live: { ...s.live, b: { ...(s.live.b ?? EMPTY_LIVE), phase: "working" } } }) as never);
    });
    expect(rowDeletes()[1]!.disabled).toBe(true);
    // A linha A continua livre: a mudança é só de B.
    expect(rowDeletes()[0]!.disabled).toBe(false);
  });
});
