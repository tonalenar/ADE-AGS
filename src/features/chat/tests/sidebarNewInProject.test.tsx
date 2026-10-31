// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onResized: () => Promise.resolve(() => undefined), isMaximized: () => Promise.resolve(false) }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o && "project" in o ? `${key}:${o.project}` : o && "count" in o ? `${key}:${o.count}` : key), i18n: { language: "pt-BR" } }),
}));

import type { ConversationCard } from "../chatModel";
import { ChatSidebar } from "../ChatSidebar";
import { useChatStore } from "../store";
import { useShelf } from "../shelf";
import { useStructured } from "../structured/store";

const card = (id: string, project: string): ConversationCard => ({
  tabId: id, title: `Conversa ${id}`, project, cwd: `/p/${project}`, branch: "main", isWorktree: false, agentId: "claude-code", agentLabel: "Claude Code", starting: false, active: false, openedAt: 1,
});
const CARDS = [card("a", "ADE-AGS"), card("b", "Outro")];

let root: Root;
let host: HTMLDivElement;
const mount = (props: Partial<React.ComponentProps<typeof ChatSidebar>> = {}) => act(async () => {
  root.render(
    <MemoryRouter>
      <ChatSidebar cards={CARDS} closed={[]} diffs={{}} selectedId="a" onCollapse={() => undefined} onAddProject={() => undefined} onReopen={() => undefined} {...props} />
    </MemoryRouter>,
  );
});
const plus = (project: string) => host.querySelector(`[aria-label="chat.sidebar.group.new:${project}"]`) as HTMLButtonElement | null;
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useShelf.setState({ snoozed: [], settled: [], pinned: [] });
  useChatStore.setState({ composing: false, composeFolder: null });
  useStructured.setState({ threads: [], live: {}, hydrated: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe('o "+" no cabeçalho de cada projeto da barra', () => {
  it("há um por projeto, com tooltip e nome acessível 'Nova conversa em <projeto>'", async () => {
    await mount();
    for (const project of ["ADE-AGS", "Outro"]) {
      expect(plus(project)).not.toBeNull();
      expect(plus(project)!.title).toBe(`chat.sidebar.group.new:${project}`);
    }
  });

  it("aparece com o mouse e com o foco dentro do cabeçalho, como o ⋯ (o teclado chega nele)", async () => {
    await mount();
    expect(plus("ADE-AGS")!.className).toContain("group-hover:flex");
    expect(plus("ADE-AGS")!.className).toContain("group-focus-within:flex");
  });

  it("clicar entrega a pasta do projeto a quem monta a conversa", async () => {
    const asked: string[] = [];
    await mount({ onNewIn: (cwd) => { asked.push(cwd); } });
    await click(plus("Outro"));
    expect(asked).toEqual(["/p/Outro"]);
  });

  it("por padrão (modo Chat) abre a tela 'Nova conversa' já nessa pasta, sem tocar nas conversas abertas", async () => {
    await mount();
    await click(plus("ADE-AGS"));
    expect(useChatStore.getState()).toMatchObject({ composing: true, composeFolder: "/p/ADE-AGS" });
  });

  it("a seção Fixadas não tem '+' (não é um projeto)", async () => {
    useShelf.setState({ pinned: ["a"] });
    await mount();
    const pinned = host.querySelector("section[aria-label='chat.sidebar.pinned']");
    expect(pinned).not.toBeNull();
    expect(pinned!.querySelector("[aria-label^='chat.sidebar.group.new']")).toBeNull();
  });

  it("o '+' não dispara o recolher do grupo", async () => {
    await mount();
    await click(plus("ADE-AGS"));
    expect(host.querySelector("section[aria-label='ADE-AGS'] [aria-expanded='true']")).not.toBeNull();
  });
});
