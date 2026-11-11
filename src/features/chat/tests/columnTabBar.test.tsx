// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onResized: () => Promise.resolve(() => undefined), isMaximized: () => Promise.resolve(false) }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o?.name ? `${key}:${o.name}` : key), i18n: { language: "pt-BR" } }), Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey }));
vi.mock("@/features/explorer/FilesView", () => ({ FilesView: () => <div data-testid="arquivos" /> }));
vi.mock("../team/TeamPanel", () => ({ TeamPanel: () => <div data-testid="time" /> }));
vi.mock("../devicesIpc", () => ({ devicesShare: () => Promise.resolve() }));

import { RightPanel } from "../RightPanel";
import { activateColumnTab, openColumnTab, useChatStore } from "../store";
import type { ConversationCard } from "../chatModel";
import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";

let root: Root;
let host: HTMLDivElement;
const conversation = { tabId: "thread:t1", agentId: "cursor", cwd: "/repo", agentLabel: "Cursor" } as unknown as ConversationCard;
const mount = () => act(async () => { root.render(<RightPanel tabId={null} cwd="/repo" project="repo" conversation={conversation} cards={[]} />); });
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;
const tabs = () => [...host.querySelectorAll("[role=tab]")] as HTMLElement[];
const pressKey = (el: Element, key: string) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useChatStore.setState({ panel: null, lastPanel: null, surfaces: [], columnTabs: [], columnActive: null, shell: null, browser: null, browserFloating: false, panelMaximized: false, terminalOpen: {} });
  useTabsStore.setState({ tabs: [], activeTabId: "tab-1" });
  useViewTabsStore.setState({ views: [], activeViewId: null, keepMountedIds: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("a barra de abas da coluna", () => {
  it("lista as abas abertas com ícone e nome, marca a ativa e alterna ao clicar", async () => {
    openColumnTab("files");
    openColumnTab("diff");
    await mount();
    expect(tabs().map((t) => t.textContent)).toEqual(["chat.panel.tab.files", "chat.panel.tab.diff"]);
    expect(tabs().map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    await click(tabs()[0]!);
    expect(useChatStore.getState().panel).toBe("files");
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(q("[data-testid=arquivos]")).not.toBeNull();
  });

  it("o × fecha só a aba (a vizinha assume); sem abas, o estado vazio mostra \"Abrir uma superfície\" com a mesma lista", async () => {
    openColumnTab("files");
    await mount();
    expect(q("[data-surface-list]")).toBeNull();
    await click(q("[aria-label='chat.panel.close:chat.panel.tab.files']"));
    expect(useChatStore.getState().panel).toBe("empty");
    expect(tabs()).toHaveLength(0);
    expect(q("[aria-label='chat.panel.empty.title'] h2")?.textContent).toBe("chat.panel.empty.title");
    const rows = [...host.querySelectorAll("[data-surface-list] > li")].map((li) => li.getAttribute("data-surface-row"));
    expect(rows).toEqual(["browser", "terminal", "files", "diff", "pr", "ios", "side", "design", "team", "renders", "snapshots"]);
  });

  it("clique do meio fecha a aba", async () => {
    openColumnTab("files");
    openColumnTab("diff");
    await mount();
    await act(async () => { tabs()[0]!.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true })); });
    expect(tabs().map((t) => t.textContent)).toEqual(["chat.panel.tab.diff"]);
  });
});

describe("o + e o menu de superfícies", () => {
  const openMenu = async () => { await click(q("[aria-label='chat.panel.addTab']")); return q("[data-surface-list]")!.parentElement!; };

  it("abre a lista com as linhas e a tecla de cada uma; as de uma letra abrem a aba e fecham o menu", async () => {
    useChatStore.setState({ panel: "empty" });
    await mount();
    const menu = await openMenu();
    expect([...menu.querySelectorAll("[role=menuitem][aria-keyshortcuts]")].map((e) => e.getAttribute("aria-keyshortcuts"))).toEqual(["B", "T", "F", "D", "P", "M", "S", "E", "O", "H", "G"]);
    await pressKey(menu, "f");
    expect(useChatStore.getState().panel).toBe("files");
    expect(q("[data-surface-list]")).toBeNull();
  });

  it("T e B abrem uma aba NOVA de terminal/navegador cada vez (várias abas do mesmo tipo)", async () => {
    useChatStore.setState({ panel: "empty" });
    await mount();
    for (const key of ["b", "b", "t"]) {
      const menu = await openMenu();
      await pressKey(menu, key);
    }
    expect(useChatStore.getState().columnTabs.map((t) => t.kind)).toEqual(["browser", "browser", "shell"]);
    expect(tabs().map((t) => t.textContent)).toEqual(["chat.panel.tab.numbered:chat.panel.tab.browser", "chat.panel.tab.numbered:chat.panel.tab.browser", "chat.panel.tab.shell"]);
  });

  it("Pull request (P) é uma linha esmaecida sem pasta; tecla de linha esmaecida e com modificador não fazem nada", async () => {
    useChatStore.setState({ panel: "empty" });
    await act(async () => { root.render(<RightPanel tabId={null} cwd={null} project="" conversation={null} cards={[]} />); });
    const menu = await openMenu();
    expect(menu.querySelector("[aria-keyshortcuts='P']")?.getAttribute("aria-disabled")).toBe("true");
    expect(menu.querySelector("[aria-keyshortcuts='S']")?.getAttribute("aria-disabled")).toBe("true");
    await pressKey(menu, "p");
    await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "d", metaKey: true, bubbles: true, cancelable: true })); });
    expect(useChatStore.getState().columnTabs).toHaveLength(0);
  });

  it("o Device tem submenu (iOS e Android) e o Android abre pelo submenu", async () => {
    useChatStore.setState({ panel: "empty" });
    await mount();
    const menu = await openMenu();
    expect(menu.querySelector("[data-surface-row=ios] [role=menu]")).toBeNull();
    await click(menu.querySelector("[data-surface-row=ios] [aria-label^='chat.panel.submenu']"));
    const sub = [...menu.querySelectorAll("[data-surface-row=ios] [role=menu] [role=menuitem]")];
    expect(sub.map((e) => e.textContent)).toEqual(["chat.panel.open.ios", "chat.panel.open.android"]);
    await click(sub[1]!);
    expect(useChatStore.getState().panel).toBe("android");
  });

  it("→ abre o submenu da linha em foco e ← o fecha; ↓ anda pelas linhas", async () => {
    useChatStore.setState({ panel: "empty" });
    await mount();
    const menu = await openMenu();
    const row = menu.querySelector("[data-surface-row=ios] [role=menuitem]") as HTMLElement;
    row.focus();
    await pressKey(row, "ArrowRight");
    expect(menu.querySelector("[data-surface-row=ios] [role=menu]")).not.toBeNull();
    await pressKey(row, "ArrowLeft");
    expect(menu.querySelector("[data-surface-row=ios] [role=menu]")).toBeNull();
    const first = menu.querySelector("[data-surface-row=browser] [role=menuitem]") as HTMLElement;
    first.focus();
    await pressKey(first, "ArrowDown");
    expect(document.activeElement?.getAttribute("aria-keyshortcuts")).toBe("T");
  });

  it("no estado vazio, as letras valem logo de cara (o launcher pega o foco)", async () => {
    useChatStore.setState({ panel: "empty" });
    await mount();
    const launcher = q("[aria-label='chat.panel.empty.title']")!;
    expect(document.activeElement).toBe(launcher);
    await pressKey(launcher, "d");
    expect(useChatStore.getState().panel).toBe("diff");
  });
});

describe("trocar de aba não remonta terminal nem navegador (o slot é o mesmo nó; só muda quem ele publica)", () => {
  it("duas abas de navegador: o slot e as páginas continuam; cada aba tem a sua página, sem repetir", async () => {
    openColumnTab("browser", { forceNew: true });
    openColumnTab("browser", { forceNew: true });
    await mount();
    const slot = q("[data-chat-browser-slot]")!;
    const second = slot.getAttribute("data-chat-browser-slot");
    expect(second).toBeTruthy();
    // Só a aba à vista resolve a página dela; a outra nasce quando for aberta.
    expect(useViewTabsStore.getState().views).toHaveLength(1);
    await click(tabs()[0]!);
    const first = q("[data-chat-browser-slot]")!;
    expect(first).toBe(slot);
    expect(first.getAttribute("data-chat-browser-slot")).not.toBe(second);
    const views = useViewTabsStore.getState().views.map((v) => v.id).sort();
    expect(views).toHaveLength(2);
    await click(tabs()[1]!);
    expect(q("[data-chat-browser-slot]")!.getAttribute("data-chat-browser-slot")).toBe(second);
    // Nenhuma página foi criada de novo nem fechada ao alternar.
    expect(useViewTabsStore.getState().views.map((v) => v.id).sort()).toEqual(views);
  });

  it("ir do navegador para outra aba e voltar devolve a mesma página (fechar a aba não a fecha)", async () => {
    openColumnTab("browser", { forceNew: true });
    openColumnTab("files");
    await mount();
    await click(tabs()[0]!);
    const id = q("[data-chat-browser-slot]")!.getAttribute("data-chat-browser-slot");
    await click(tabs()[1]!);
    expect(q("[data-chat-browser-slot]")).toBeNull();
    expect(useViewTabsStore.getState().views.map((v) => v.id)).toEqual([id]);
    await click(tabs()[0]!);
    expect(q("[data-chat-browser-slot]")!.getAttribute("data-chat-browser-slot")).toBe(id);
  });

  it("duas abas de terminal: cada uma é um shell próprio, o slot é o mesmo nó e nenhum PTY some ao alternar ou fechar a aba", async () => {
    openColumnTab("shell", { forceNew: true });
    await mount();
    openColumnTab("shell", { forceNew: true });
    await mount();
    const shells = () => useTabsStore.getState().tabs.filter((t) => t.agentId === "bash").map((t) => t.id);
    expect(shells()).toHaveLength(2);
    const slot = q("[data-chat-shell-slot]")!;
    const second = slot.getAttribute("data-chat-shell-slot");
    await click(tabs()[0]!);
    const first = q("[data-chat-shell-slot]")!;
    expect(first).toBe(slot);
    expect(first.getAttribute("data-chat-shell-slot")).not.toBe(second);
    expect(tabs().map((t) => t.textContent)).toEqual(["chat.panel.tab.numbered:chat.panel.tab.shell", "chat.panel.tab.numbered:chat.panel.tab.shell"]);
    // Fechar a aba da coluna só tira o assento: o PTY (aba de shell) continua vivo.
    await click(q("[data-column-tab] [aria-label^='chat.panel.close']"));
    expect(shells()).toHaveLength(2);
  });

  it("alternar entre abas por código (activateColumnTab) também só troca o slot", async () => {
    openColumnTab("shell", { forceNew: true });
    await mount();
    openColumnTab("files");
    await mount();
    expect(q("[data-chat-shell-slot]")).toBeNull();
    activateColumnTab(useChatStore.getState().columnTabs[0]!.id);
    await mount();
    expect(q("[data-chat-shell-slot]")).not.toBeNull();
    expect(useTabsStore.getState().tabs.filter((t) => t.agentId === "bash")).toHaveLength(1);
  });
});
