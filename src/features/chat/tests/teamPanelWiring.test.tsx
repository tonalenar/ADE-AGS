// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/invokeMock").then((m) => m.tauriCoreMock()));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("../attachments/useChatFileDrop", () => ({ useChatFileDrop: () => undefined }));
vi.mock("../liveStore", () => ({ startChatLive: () => () => undefined, useChatLive: () => ({}) }));
vi.mock("../queueRunner", () => ({ startQueueRunner: () => () => undefined }));
vi.mock("../projectScriptAutomation", () => ({ startProjectScriptSettleWatcher: () => () => undefined }));
vi.mock("../projectDefaultsSync", () => ({ syncProjectDefaults: () => Promise.resolve() }));
vi.mock("../structured/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../structured/store")>();
  return { ...actual, startStructured: () => () => undefined };
});
vi.mock("@/features/agents/localAcpStore", () => ({
  useLocalAcpStore: (select: (s: { providers: unknown[]; loaded: boolean; load: () => Promise<void> }) => unknown) =>
    select({ providers: [], loaded: true, load: async () => undefined }),
}));
vi.mock("../ChatSidebar", () => ({ ChatSidebar: () => null, IconButton: () => null }));
vi.mock("../RightPanel", () => ({ RightPanel: () => null }));
vi.mock("../ConversationView", () => ({ ConversationView: () => null, CHAT_SHELL_ATTR: "data-chat-shell" }));
vi.mock("../structured/StructuredConversationView", () => ({ StructuredConversationView: () => null }));
vi.mock("../NewConversation", () => ({ NewConversation: () => null, pickProjectFolder: async () => null }));
vi.mock("../PanelToolbar", () => ({ PanelToolbar: () => null }));
vi.mock("../ShellModeSwitch", () => ({ ShellModeSwitch: () => null }));
vi.mock("../permissions/PermissionsInbox", () => ({ PermissionsInbox: () => null }));
vi.mock("../permissions/PermissionsManager", () => ({ PermissionsManager: () => null }));
vi.mock("../team/TeamThreadFeed", () => ({ TeamHeaderBadge: () => null }));
vi.mock("@/features/missions/MissionsSection", () => ({ MissionsSection: () => null }));
vi.mock("../ChatPage", () => ({ ChatPage: () => null }));
vi.mock("../ChatPageSidebar", () => ({ SettingsSidebar: () => null, SpacesSidebar: () => null }));
vi.mock("@/app/WindowLights", () => ({ WindowControls: () => null, WindowLights: () => null }));
vi.mock("../attachments/DropOverlay", () => ({ DropOverlay: () => null }));
vi.mock("../summary/SummaryPane", () => ({ SummaryPane: () => null }));
vi.mock("../summary/SummaryPopover", () => ({ SUMMARY_POPOVER_W: 280, SummaryPopover: () => null }));
vi.mock("../ChatProjectBadge", () => ({ ProjectBadge: () => null }));
vi.mock("../attachments/MediaViewerContext", () => ({ MediaViewerProvider: ({ children }: { children: unknown }) => children }));
vi.mock("../attachments/AttachmentStrip", () => ({ AttachCwdContext: { Provider: ({ children }: { children: unknown }) => children } }));
vi.mock("../timeline/CodeBlockFrame", () => ({ RunCodeContext: { Provider: ({ children }: { children: unknown }) => children } }));

import { invokeMock, useInvokeMock } from "@/test/invokeMock";
import { ChatShell } from "../ChatShell";
import { useChatStore } from "../store";
import { useStructured } from "../structured/store";
import { useTeamDraft } from "../team/draftStore";
import type { ThreadRow } from "../structured/ipc";

useInvokeMock();

const thread: ThreadRow = {
  id: "th", agentId: "codex", cwd: "/repo", title: "login", model: null, effort: null, access: "ask",
  accountId: null, state: "active", createdAt: 1, updatedAt: 1,
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  invokeMock.on("scm_working_diff", null);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  useChatStore.setState({
    panel: null, surfaces: [], lastPanel: null, composing: true, thread: null, summaryOpen: false, summaryPinned: false, panelMaximized: false,
  });
  useTeamDraft.setState({ members: [], lead: null, adding: false, editing: null });
  useStructured.setState({ threads: [], live: {}, hydrated: {}, goals: {}, goalNotices: {}, logFailures: {} });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

const mount = () => act(async () => {
  root.render(<MemoryRouter><ChatShell groups={[]} /></MemoryRouter>);
});

describe("trocar de conversa não mexe na aba do painel direito", () => {
  it("ligar uma conversa não reabre o Time", async () => {
    await mount();
    expect(useChatStore.getState().panel).toBeNull();

    useStructured.setState({ threads: [thread] });
    await act(async () => {
      useChatStore.setState({ composing: false, thread: "th" });
    });
    await mount();
    expect(useChatStore.getState().panel).toBeNull();
  });

  it("transitar de conversa ligada para rascunho preenchido mantém o Time", async () => {
    useStructured.setState({ threads: [thread] });
    useChatStore.setState({ composing: false, thread: "th", panel: "team", surfaces: ["team"] });
    await mount();

    await act(async () => {
      useTeamDraft.setState({ members: [{ id: "d1" }] as never });
      useChatStore.setState({ composing: true });
    });
    await mount();
    expect(useChatStore.getState().panel).toBe("team");
  });
});
