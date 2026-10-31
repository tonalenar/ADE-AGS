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
import { useChatStore } from "../store";

let root: Root;
let host: HTMLDivElement;
const mountToolbar = (terminalAvailable = false) => act(async () => { root.render(<PanelToolbar tabId="tab-1" terminalAvailable={terminalAvailable} />); });
const icon = (name: string) => host.querySelector(`[role=toolbar] [aria-label="${name}"]`) as HTMLButtonElement | null;
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useChatStore.setState({ panel: "summary", surfaces: [], terminalOpen: {}, panelMaximized: false });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("a fileira de ícones (no cabeçalho principal)", () => {
  it("tem Resumo, Terminal, Diff, Navegador, Aparelho, Arquivos e o ⋯, sem abas de texto", async () => {
    await mountToolbar();
    for (const id of ["summary", "terminal", "diff", "browser", "ios", "files"]) expect(icon(`chat.panel.open.${id}`)).not.toBeNull();
    expect(host.querySelector("[aria-label='chat.panel.more']")).not.toBeNull();
    expect(host.querySelector("[role=tab]")).toBeNull();
  });

  it("o Resumo começa destacado; clicar em outro ícone troca; clicar no ativo recolhe o painel", async () => {
    await mountToolbar();
    expect(icon("chat.panel.open.summary")!.getAttribute("aria-pressed")).toBe("true");
    await click(icon("chat.panel.open.files"));
    expect(useChatStore.getState().panel).toBe("files");
    expect(icon("chat.panel.open.files")!.getAttribute("aria-pressed")).toBe("true");
    await click(icon("chat.panel.open.files"));
    expect(useChatStore.getState().panel).toBeNull();
    await click(icon("chat.panel.open.summary"));
    expect(useChatStore.getState().panel).toBe("summary");
  });

  it("o tooltip leva o nome e a tecla; o terminal fica esmaecido sem gaveta e alterna com ela", async () => {
    await mountToolbar();
    expect(icon("chat.panel.open.diff")!.title).toBe("chat.panel.open.diff (D)");
    expect(icon("chat.panel.open.terminal")!.disabled).toBe(true);
    await mountToolbar(true);
    await click(icon("chat.panel.open.terminal"));
    expect(useChatStore.getState().terminalOpen["tab-1"]).toBe(true);
    await click(icon("chat.panel.open.terminal"));
    expect(useChatStore.getState().terminalOpen["tab-1"]).toBe(false);
  });

  it("o ⋯ abre Design, Android, Time e PR com as mesmas teclas", async () => {
    await mountToolbar();
    await click(host.querySelector("[aria-label='chat.panel.more']"));
    expect([...host.querySelectorAll("[role=menuitem]")].map((e) => e.getAttribute("aria-keyshortcuts")).filter(Boolean)).toEqual(["S", "A", "O", "P"]);
    await click(host.querySelector("[role=menuitem][aria-keyshortcuts='O']"));
    expect(useChatStore.getState().panel).toBe("team");
  });
});

describe("o \"expandir\" do painel mora no ⋯ do cabeçalho principal", () => {
  const expandItem = () => [...host.querySelectorAll("[role=menuitem]")].find((e) => e.textContent === "chat.panel.maximize") as HTMLButtonElement | undefined;

  it("esmaecido enquanto não há coluna (Resumo à vista)", async () => {
    await mountToolbar();
    await click(host.querySelector("[aria-label='chat.panel.more']"));
    expect(expandItem()?.disabled).toBe(true);
    await click(expandItem()!);
    expect(useChatStore.getState().panelMaximized).toBe(false);
  });

  it("com uma superfície no dock, expande e fecha o menu; de novo, restaura", async () => {
    useChatStore.setState({ panel: "diff" });
    await mountToolbar();
    await click(host.querySelector("[aria-label='chat.panel.more']"));
    expect(expandItem()?.disabled).toBe(false);
    await click(expandItem()!);
    expect(useChatStore.getState().panelMaximized).toBe(true);
    expect(host.querySelector("[role=menu]")).toBeNull();
    await click(host.querySelector("[aria-label='chat.panel.more']"));
    expect(expandItem()?.getAttribute("aria-pressed")).toBe("true");
    await click(expandItem()!);
    expect(useChatStore.getState().panelMaximized).toBe(false);
  });
});

describe("o dock (coluna com borda) só abriga as outras superfícies", () => {
  const mountDock = () => act(async () => { root.render(<RightPanel tabId="tab-1" cwd="/repo" project="repo" conversation={null} cards={[]} />); });

  it("com o Resumo à vista não há coluna nenhuma", async () => {
    await mountDock();
    expect(host.querySelector("aside")).toBeNull();
  });

  it("com Arquivos à vista a coluna aparece, com borda e sem a fileira de ícones (ela está no cabeçalho)", async () => {
    useChatStore.setState({ panel: "files" });
    await mountDock();
    expect(host.querySelector("aside")?.className).toContain("border-l");
    expect(host.querySelector("[data-testid=arquivos]")).not.toBeNull();
    expect(host.querySelector("aside [role=toolbar]")).toBeNull();
  });

  it("maximizado, a fileira volta para o cabeçalho do dock (o principal some)", async () => {
    useChatStore.setState({ panel: "diff", panelMaximized: true });
    await mountDock();
    expect(host.querySelector("aside [role=toolbar]")).not.toBeNull();
  });

  it("sem a faixa vazia do topo: nada de h-[52px] nem de botões de expandir/recolher dentro da coluna", async () => {
    useChatStore.setState({ panel: "files" });
    await mountDock();
    const aside = host.querySelector("aside")!;
    expect(aside.querySelector("[class*='h-[52px]']")).toBeNull();
    // Só sobram os botões da janela (Windows/Linux), que não são da coluna.
    const own = [...aside.querySelectorAll("button")].filter((b) => !(b.getAttribute("aria-label") ?? "").startsWith("window."));
    expect(own).toEqual([]);
    // O conteúdo da superfície começa logo no topo da coluna: sem a borda que separava a faixa.
    expect(aside.querySelector("[data-testid=arquivos]")?.parentElement?.className ?? "").not.toContain("border-t");
  });

  it("mantém só uma região de arrasto fina no topo, que não cobre a superfície", async () => {
    useChatStore.setState({ panel: "files" });
    await mountDock();
    const drag = host.querySelector("aside [data-tauri-drag-region]") as HTMLElement;
    expect(drag.className).toContain("absolute");
    expect(drag.className).toContain("h-2");
  });

  it("maximizado, a barra flutuante traz a fileira, restaurar e recolher", async () => {
    useChatStore.setState({ panel: "diff", panelMaximized: true });
    await mountDock();
    const restore = host.querySelector("aside [aria-label='chat.panel.maximize']") as HTMLButtonElement;
    expect(restore.getAttribute("aria-pressed")).toBe("true");
    await click(restore);
    expect(useChatStore.getState().panelMaximized).toBe(false);
  });
});
