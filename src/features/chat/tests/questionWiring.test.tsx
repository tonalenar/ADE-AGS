// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/invokeMock").then((m) => m.tauriCoreMock()));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@/features/agents/useAvailableAgents", () => ({ useAvailableAgents: () => [] }));
vi.mock("../fastMode", () => ({ fastModeForThread: () => false, saveFastModeForThread: () => undefined }));
vi.mock("../harnessCapabilities", () => ({
  goalPauseResumeAvailable: () => false,
  isLegacyGoalClearAlias: () => false,
  matrixProviderForAgent: () => "codex",
  useHarnessCapability: () => ({ support: "unsupported", available: false, loading: false, reason: null }),
}));
vi.mock("../chatPrefs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chatPrefs")>();
  return { ...actual, useChatPrefs: () => ({ ...actual.useChatPrefs(), followUpBehavior: "queue", fastMode: false }) };
});
vi.mock("../team/TeamComposer", () => ({ useTeamComposer: () => null }));
vi.mock("../ChatFrame", () => ({ ChatFrame: ({ list }: { list: (n: number) => unknown }) => list(0) }));
vi.mock("../ChatComposer", () => ({ ChatComposer: () => null }));
vi.mock("../ComposerAssistMenu", () => ({ ComposerAssistMenu: () => null }));
vi.mock("../NewConversation", () => ({ ContextStrip: () => null }));
vi.mock("../permissions/PermissionCard", () => ({ PermissionCard: () => null }));
vi.mock("../permissions/permissionsStore", () => ({ usePendingAsks: () => [] }));
vi.mock("../team/TeamThreadFeed", () => ({ TeamThreadFeed: () => null }));
vi.mock("../structured/HarnessRunFeed", () => ({ HarnessRunFeed: () => null }));
vi.mock("../structured/AgentSwitchDialog", () => ({ AgentSwitchDialog: () => null }));
vi.mock("../structured/LogFailureNotice", () => ({ LogFailureNotice: () => null }));
vi.mock("../autocompact/ContextMeter", () => ({ ContextMeter: () => null }));
vi.mock("../AgentModelPicker", () => ({ AgentModelPicker: () => null }));
vi.mock("../structured/ThreadAccountMenu", () => ({ ThreadAccountMenu: () => null }));

import { invokeMock, useInvokeMock } from "@/test/invokeMock";
import { EMPTY_LIVE } from "../structured/model";
import { useStructured } from "../structured/store";
import { StructuredConversationView } from "../structured/StructuredConversationView";
import type { RequestRow, ThreadRow } from "../structured/ipc";
import type { ConversationCard } from "../chatModel";
import type { TimelineItem } from "../timeline/types";

useInvokeMock();

const OPTIONS = ["Autorizo", "Eu faço"];
const request: RequestRow = {
  id: "q1", threadId: "th", kind: "question", itemId: null, title: "", detail: "",
  options: [{ id: "opt", question: "Autoriza?", options: OPTIONS }],
  state: "pending", createdAt: 1,
};
const ask: TimelineItem = {
  kind: "tool", id: "q1", tool: "question", status: "running", label: "pergunta",
  question: { text: "Autoriza?", options: OPTIONS },
};
const thread: ThreadRow = {
  id: "th", agentId: "codex", cwd: "/repo", title: "login", model: null, effort: null, access: "ask",
  accountId: null, state: "active", createdAt: 1, updatedAt: 1,
};
const card: ConversationCard = {
  tabId: "thread:th", title: "login", project: "repo", cwd: "/repo", branch: null, isWorktree: false,
  agentId: "codex", agentLabel: "Codex", starting: false, active: true, openedAt: 1,
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  useStructured.setState({
    threads: [thread],
    hydrated: { th: true },
    live: { th: { ...EMPTY_LIVE, items: [{ kind: "user", id: "u", text: "monte" }, ask], requests: [request], phase: "working" } },
    goals: {}, goalNotices: {}, logFailures: {},
  });
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const option = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const render = () => act(async () => {
  root.render(<StructuredConversationView card={card} thread={thread} cards={[card]} />);
});

describe("a conversa por protocolo liga a resposta ao cartão da pergunta", () => {
  it("com pergunta esperando, o clique responde o pedido aberto", async () => {
    invokeMock.on("chat_request_answer", true);
    await render();
    await act(async () => { option(OPTIONS[0]!)!.click(); });
    expect(invokeMock.calls("chat_request_answer")).toEqual([{ requestId: "q1", choice: OPTIONS[0] }]);
  });

  it("sem pergunta as opções somem", async () => {
    useStructured.setState({
      live: { th: { ...EMPTY_LIVE, items: [{ kind: "user", id: "u", text: "monte" }, ask], requests: [], phase: "idle" } },
    });
    await render();
    expect(option(OPTIONS[0]!)).toBeUndefined();
  });
});
