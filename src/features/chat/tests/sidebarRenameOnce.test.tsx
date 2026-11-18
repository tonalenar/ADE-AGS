// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onResized: () => Promise.resolve(() => undefined), isMaximized: () => Promise.resolve(false) }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }),
}));

import type { ConversationCard } from "../chatModel";
import { ChatSidebar } from "../ChatSidebar";
import { useChatStore } from "../store";
import { useShelf } from "../shelf";
import { useStructured } from "../structured/store";
import { useTabsStore } from "@/features/tabs/store";

const card = (id: string, project: string): ConversationCard => ({
  tabId: id, title: `Conversa ${id}`, project, cwd: `/p/${project}`, branch: "main", isWorktree: false, agentId: "claude-code", agentLabel: "Claude Code", starting: false, active: false, openedAt: 1,
});
const CARDS = [card("a", "ADE-AGS")];

let root: Root;
let host: HTMLDivElement;
let originalRename: (id: string, title: string) => void;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useShelf.setState({ snoozed: [], settled: [], pinned: [] });
  useChatStore.setState({ composing: false, composeFolder: null });
  useStructured.setState({ threads: [], live: {}, hydrated: {} });
  originalRename = useTabsStore.getState().renameTab;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  useTabsStore.setState({ renameTab: originalRename });
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("renomear a conversa confirma uma vez", () => {
  it("Enter e o blur que chega com o campo ainda na tela gravam o nome uma vez só", async () => {
    const rename = vi.fn(originalRename);
    useTabsStore.setState({ renameTab: rename });
    await act(async () => {
      root.render(<MemoryRouter><ChatSidebar cards={CARDS} closed={[]} diffs={{}} selectedId="a" onCollapse={() => undefined} onAddProject={() => undefined} onReopen={() => undefined} /></MemoryRouter>);
    });
    const row = host.querySelector('[data-session-id="a"]') as HTMLElement;
    await act(async () => { row.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })); });
    const input = host.querySelector('input[aria-label="chat.sidebar.renameLabel"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = "Novo nome";
    // O blur chega antes de a linha sair da tela (como no navegador, ao tirar o campo focado).
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith("a", "Novo nome");
  });
});
