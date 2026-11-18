// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));

// O composer é capturado: o teste chama o `onSubmit` que a view lhe passa, como a caixa faz ao enviar.
const view = vi.hoisted(() => ({
  composer: null as null | { onSubmit: (text: string, attachments: unknown[]) => Promise<boolean> },
  answerRequest: null as unknown,
}));
vi.mock("../ChatComposer", () => ({
  ChatComposer: (props: { onSubmit: (text: string, attachments: unknown[]) => Promise<boolean> }) => {
    view.composer = props;
    return null;
  },
}));
vi.mock("../ChatFrame", () => ({
  ChatFrame: ({ composer, list }: { composer: React.ReactNode; list: (inset: number) => React.ReactNode }) => <div>{composer}{list(0)}</div>,
}));
vi.mock("../timeline/ConversationTimeline", () => ({ TimelineView: () => null }));
vi.mock("@/features/agents/useAvailableAgents", () => ({
  useAvailableAgents: () => [{ id: "claude-code", label: "Claude Code", command: "claude", available: true }],
}));
vi.mock("../AgentModelPicker", () => ({ AgentModelPicker: () => null, EffortMenu: () => null, hasEffort: () => false }));
vi.mock("../structured/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../structured/store")>();
  const { vi: viTest } = await import("vitest");
  const answerRequest = viTest.fn(() => Promise.resolve(false));
  view.answerRequest = answerRequest;
  return { ...actual, answerRequest, hydrateThread: () => undefined };
});

import type { ConversationCard } from "../chatModel";
import { StructuredConversationView } from "../structured/StructuredConversationView";
import { EMPTY_LIVE } from "../structured/model";
import { useStructured } from "../structured/store";

const card: ConversationCard = {
  tabId: "thread:t1", title: "Conversa", project: "ADE", cwd: "/p/ade", branch: "main", isWorktree: false, agentId: "claude-code", agentLabel: "Claude Code", starting: false, active: false, openedAt: 1,
};
const thread = { id: "t1", agentId: "claude-code", cwd: "/p/ade", title: "Conversa", model: null, effort: null, access: "ask", accountId: null, state: "active", parentRef: null, forkMode: null, forkReason: null } as never;
// Uma pergunta do agente, ainda sem resposta.
const question = { id: "req-1", threadId: "t1", kind: "question", itemId: null, title: "Qual?", detail: "", options: [{ id: "q1", question: "Qual?", options: ["A", "B"] }], state: "pending", createdAt: 1 };

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  view.composer = null;
  useStructured.setState({ threads: [thread], live: { t1: { ...EMPTY_LIVE, requests: [question as never] } }, hydrated: { t1: true } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("a resposta à pergunta do agente só limpa a caixa quando o backend aceita", () => {
  it("pergunta_recusada_mantem_o_texto: a recusa do backend devolve false, e a caixa mantém o texto", async () => {
    await act(async () => { root.render(<StructuredConversationView card={card} thread={thread} />); });
    expect(view.composer).not.toBeNull();
    let accepted: boolean | undefined;
    await act(async () => { accepted = await view.composer!.onSubmit("minha resposta", []); });
    expect(view.answerRequest).toHaveBeenCalledWith("t1", "req-1", "minha resposta");
    expect(accepted).toBe(false);
  });
});
