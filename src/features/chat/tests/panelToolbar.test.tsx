// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onResized: () => Promise.resolve(() => undefined), isMaximized: () => Promise.resolve(false) }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }), Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey }));
vi.mock("@/features/explorer/FilesView", () => ({ FilesView: () => <div data-testid="arquivos" /> }));
vi.mock("../team/TeamPanel", () => ({ TeamPanel: () => <div data-testid="time" /> }));
vi.mock("../devicesIpc", () => ({ devicesShare: () => Promise.resolve() }));

import { PanelToolbar } from "../PanelToolbar";
import { RightPanel } from "../RightPanel";
import { closeSummary, setRightPanel, useChatStore } from "../store";
import type { ConversationCard } from "../chatModel";
import { useTabsStore } from "@/features/tabs/store";
import { SUMMARY_POPOVER_W, SummaryPopover } from "../summary/SummaryPopover";

let root: Root;
let host: HTMLDivElement;
const mountToolbar = (terminalAvailable = false, drawerTabId: string | null = "tab-1") =>
  act(async () => { root.render(<PanelToolbar drawerTabId={drawerTabId} terminalAvailable={terminalAvailable} />); });
const icon = (name: string) => host.querySelector(`[role=toolbar] [aria-label="${name}"]`) as HTMLButtonElement | null;
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useChatStore.setState({ panel: null, summaryPinned: false, summaryOpen: false, surfaces: [], columnTabs: [], columnActive: null, terminalOpen: {}, panelMaximized: false });
  localStorage.removeItem("ags.chat.summaryPinned");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("o cabeçalho da conversa guarda só o que é da conversa (as superfícies abrem pelo + da coluna)", () => {
  it("tem Resumo, Tarefas e o painel inferior (coluna fechada); sem ícones de superfície nem ⋯", async () => {
    await mountToolbar(true);
    expect(icon("chat.panel.open.summary")).not.toBeNull();
    expect(host.querySelector("[data-tasks-button]")).not.toBeNull();
    expect(icon("chat.panel.bottom")).not.toBeNull();
    for (const id of ["terminal", "diff", "browser", "ios", "files", "team"]) expect(icon(`chat.panel.open.${id}`)).toBeNull();
    expect(host.querySelector("[aria-label='chat.panel.more']")).toBeNull();
    expect(host.querySelector("[role=tab]")).toBeNull();
  });

  it("com a coluna aberta, o painel inferior mora na barra dela (some do cabeçalho)", async () => {
    useChatStore.setState({ panel: "diff" });
    await mountToolbar(true);
    expect(icon("chat.panel.bottom")).toBeNull();
    expect(icon("chat.panel.open.summary")).not.toBeNull();
  });

  it("o Resumo não abre superfície do painel", async () => {
    await mountToolbar();
    await click(icon("chat.panel.open.summary"));
    expect(useChatStore.getState().panel).toBeNull();
  });

  it("sem painel, o ícone do Resumo liga e desliga a coluna fixa (marcado quando ligado, e lembrado)", async () => {
    await mountToolbar();
    await click(icon("chat.panel.open.summary"));
    expect(useChatStore.getState().summaryPinned).toBe(true);
    expect(useChatStore.getState().summaryOpen).toBe(false);
    expect(icon("chat.panel.open.summary")!.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("ags.chat.summaryPinned")).toBe("on");
    await click(icon("chat.panel.open.summary"));
    expect(useChatStore.getState().summaryPinned).toBe(false);
    expect(icon("chat.panel.open.summary")!.getAttribute("aria-pressed")).toBe("false");
    expect(localStorage.getItem("ags.chat.summaryPinned")).toBe("off");
  });

  it("outro painel substitui a coluna (o ícone passa a dizer do cartão); fechar o painel a traz de volta e fecha o cartão", async () => {
    useChatStore.setState({ summaryPinned: true });
    await mountToolbar();
    await act(async () => { useChatStore.setState({ panel: "files" }); });
    // A coluna não aparece com painel (ver `ChatShell`): o ícone fica desmarcado até abrir o cartão.
    expect(icon("chat.panel.open.summary")!.getAttribute("aria-pressed")).toBe("false");
    await click(icon("chat.panel.open.summary"));
    expect(useChatStore.getState().summaryOpen).toBe(true);
    expect(useChatStore.getState().summaryPinned).toBe(true);
    await act(async () => { setRightPanel(null); });
    expect(useChatStore.getState().summaryOpen).toBe(false);
    expect(icon("chat.panel.open.summary")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("o tooltip do Resumo leva a tecla; o painel inferior fica esmaecido sem conversa e alterna a gaveta com ela", async () => {
    await mountToolbar();
    expect(icon("chat.panel.open.summary")!.title).toBe("chat.panel.open.summary (R)");
    expect(icon("chat.panel.bottom")!.disabled).toBe(true);
    await mountToolbar(true);
    await click(icon("chat.panel.bottom"));
    expect(useChatStore.getState().terminalOpen["tab-1"]).toBe(true);
    await click(icon("chat.panel.bottom"));
    expect(useChatStore.getState().terminalOpen["tab-1"]).toBe(false);
  });

  it("sem gaveta (conversa por protocolo), o painel inferior abre e fecha a aba Terminal do painel", async () => {
    await mountToolbar(true, null);
    await click(icon("chat.panel.bottom"));
    expect(useChatStore.getState().panel).toBe("shell");
    expect(useChatStore.getState().terminalOpen).toEqual({});
  });
});

describe("o dock (coluna com borda): barra de abas no topo e a superfície embaixo", () => {
  const mountDock = () => act(async () => { root.render(<RightPanel tabId="tab-1" cwd="/repo" project="repo" conversation={null} cards={[]} />); });

  it("a aba Terminal abre um shell na pasta da conversa, sem trocar a conversa aberta, e reaproveita o da pasta", async () => {
    useTabsStore.setState({ tabs: [], activeTabId: "tab-1" });
    useChatStore.setState({ panel: "shell", shell: null });
    const conversation = { tabId: "thread:t1", agentId: "cursor", cwd: "/repo" } as unknown as ConversationCard;
    await act(async () => { root.render(<RightPanel tabId={null} cwd="/repo" project="repo" conversation={conversation} cards={[]} />); });
    const shells = useTabsStore.getState().tabs.filter((t) => t.agentId === "bash");
    expect(shells.map((t) => t.cwd)).toEqual(["/repo"]);
    expect(useTabsStore.getState().activeTabId).toBe("tab-1");
    expect(host.querySelector(`[data-chat-shell-slot="${shells[0]!.id}"]`)).not.toBeNull();
    // O terminal não é montado no painel: o `TerminalPanel` o desenha por cima do slot.
    expect(host.querySelector(".xterm")).toBeNull();
    await act(async () => { root.render(<div />); });
    await act(async () => { root.render(<RightPanel tabId={null} cwd="/repo" project="repo" conversation={conversation} cards={[]} />); });
    expect(useTabsStore.getState().tabs.filter((t) => t.agentId === "bash")).toHaveLength(1);
  });

  it("com Arquivos à vista a coluna aparece, com borda, a barra de abas e sem a fileira de ícones do cabeçalho", async () => {
    useChatStore.setState({ panel: "files" });
    await mountDock();
    expect(host.querySelector("aside")?.className).toContain("border-l");
    expect(host.querySelector("[data-testid=arquivos]")).not.toBeNull();
    expect(host.querySelector("aside [role=toolbar]")).toBeNull();
    const bar = host.querySelector("aside [data-column-tabbar]")!;
    expect(bar.querySelector("[role=tablist] [role=tab][aria-selected=true]")?.textContent).toBe("chat.panel.tab.files");
  });

  it("a barra tem o + e, à direita, expandir, painel inferior e recolher; sem a faixa antiga de 52 px", async () => {
    useChatStore.setState({ panel: "files" });
    await mountDock();
    const bar = host.querySelector("aside [data-column-tabbar]")!;
    for (const label of ["chat.panel.addTab", "chat.panel.maximize", "chat.panel.bottom", "chat.panel.toggle"]) expect(bar.querySelector(`[aria-label='${label}']`)).not.toBeNull();
    expect(host.querySelector("aside [class*='h-[52px]']")).toBeNull();
  });

  it("a barra é a região de arrasto da coluna; o conteúdo começa logo abaixo dela", async () => {
    useChatStore.setState({ panel: "files" });
    await mountDock();
    expect(host.querySelector("aside [data-column-tabbar]")?.hasAttribute("data-tauri-drag-region")).toBe(true);
  });

  it("maximizado, o restaurar fica na barra da coluna (o cabeçalho principal some)", async () => {
    useChatStore.setState({ panel: "diff", panelMaximized: true });
    await mountDock();
    const restore = host.querySelector("aside [aria-label='chat.panel.restore']") as HTMLButtonElement;
    expect(restore.getAttribute("aria-pressed")).toBe("true");
    await click(restore);
    expect(useChatStore.getState().panelMaximized).toBe(false);
  });

  it("recolher pela barra fecha a coluna", async () => {
    useChatStore.setState({ panel: "diff" });
    await mountDock();
    await click(host.querySelector("aside [aria-label='chat.panel.toggle']"));
    expect(useChatStore.getState().panel).toBeNull();
  });
});

describe("com outro painel aberto, o Resumo é um cartão flutuante encostado no painel (como no Claude Code)", () => {
  beforeEach(() => useChatStore.setState({ panel: "ios" }));
  // A coluna da conversa como no `ChatShell`: a fileira no cabeçalho e o cartão desenhado pela coluna (`relative`).
  function Coluna() {
    const open = useChatStore((s) => s.summaryOpen);
    return (
      <main data-testid="coluna" className="relative">
        <p data-testid="conversa">texto</p>
        <PanelToolbar drawerTabId={null} terminalAvailable />
        {open && <SummaryPopover width={SUMMARY_POPOVER_W} onClose={closeSummary}><div data-testid="cartoes">Ambiente</div></SummaryPopover>}
      </main>
    );
  }
  const mountWithSummary = () => act(async () => { root.render(<Coluna />); });
  const card = () => host.querySelector("[role=dialog][data-summary-popover]") as HTMLElement | null;
  const down = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });

  it("abre por cima, sem mexer no painel direito (o simulador continua à vista), com o foco dentro e o ícone marcado", async () => {
    useChatStore.setState({ panel: "ios" });
    await mountWithSummary();
    await click(icon("chat.panel.open.summary"));
    expect(card()?.querySelector("[data-testid=cartoes]")).not.toBeNull();
    expect(useChatStore.getState().panel).toBe("ios");
    expect(icon("chat.panel.open.summary")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(card());
    // Ancorado na coluna da conversa, à direita (encostado no painel), abaixo do cabeçalho: não dentro da fileira.
    expect(card()!.parentElement?.getAttribute("data-testid")).toBe("coluna");
    expect(card()!.className).toContain("right-2");
    expect(card()!.className).toContain("top-[52px]");
    expect(card()!.closest("[role=toolbar]")).toBeNull();
    // Um pouco menor que a coluna fixa (420 px).
    expect(card()!.style.width).toBe("310px");
    // Clicar dentro não fecha.
    await down(card()!.querySelector("[data-testid=cartoes]")!);
    expect(card()).not.toBeNull();
  });

  it("fecha com clique fora", async () => {
    await mountWithSummary();
    await click(icon("chat.panel.open.summary"));
    await down(host.querySelector("[data-testid=conversa]")!);
    expect(card()).toBeNull();
    expect(useChatStore.getState().summaryOpen).toBe(false);
  });

  it("fecha com Esc e o foco volta ao ícone", async () => {
    await mountWithSummary();
    await click(icon("chat.panel.open.summary"));
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(icon("chat.panel.open.summary"));
  });

  it("o ícone alterna; com o painel maximizado, ele volta ao tamanho normal (o cartão flutua sobre a conversa)", async () => {
    useChatStore.setState({ panel: "browser", panelMaximized: true });
    await mountWithSummary();
    await click(icon("chat.panel.open.summary"));
    expect(useChatStore.getState().panelMaximized).toBe(false);
    expect(useChatStore.getState().panel).toBe("browser");
    await click(icon("chat.panel.open.summary"));
    expect(card()).toBeNull();
  });
});
