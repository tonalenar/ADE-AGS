// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import { activateColumnTab, addSurface, closeColumnTab, moveColumnTab, openColumnTab, setColumnTabResource, setRightPanel, toggleRightPanel, useChatStore } from "../store";

const state = () => useChatStore.getState();
const kinds = () => state().columnTabs.map((t) => t.kind);

beforeEach(() => useChatStore.setState({ panel: null, lastPanel: null, surfaces: [], columnTabs: [], columnActive: null, browserFloating: false, browserFloatRect: null, panelMaximized: false }));

describe("a coluna segue o `panel` (quem só chama setRightPanel/addSurface ganha a aba)", () => {
  it("abrir uma superfície cria a aba ativa; abrir de novo não repete", () => {
    setRightPanel("files");
    addSurface("files");
    expect(kinds()).toEqual(["files"]);
    expect(state().columnActive).toBe(state().columnTabs[0]!.id);
    setRightPanel("diff");
    expect(kinds()).toEqual(["files", "diff"]);
    setRightPanel("files");
    expect(state().columnActive).toBe(state().columnTabs[0]!.id);
    expect(kinds()).toEqual(["files", "diff"]);
  });

  it("o estado vazio desativa a aba sem fechá-las; fechar o painel guarda a ativa e reabrir volta nela", () => {
    openColumnTab("browser", { forceNew: true });
    openColumnTab("browser", { forceNew: true });
    const second = state().columnTabs[1]!.id;
    expect(state().columnActive).toBe(second);
    setRightPanel(null);
    expect(state().columnActive).toBe(second);
    toggleRightPanel();
    expect(state().panel).toBe("browser");
    expect(state().columnActive).toBe(second);
    setRightPanel("empty");
    expect(state().columnActive).toBeNull();
    expect(state().columnTabs).toHaveLength(2);
  });
});

describe("abrir, alternar e fechar abas", () => {
  it("o + abre sempre outra aba de navegador/terminal, e a nova fica à vista com o painel nela", () => {
    openColumnTab("browser", { forceNew: true });
    openColumnTab("shell", { forceNew: true });
    openColumnTab("shell", { forceNew: true });
    expect(kinds()).toEqual(["browser", "shell", "shell"]);
    expect(state().panel).toBe("shell");
    expect(state().surfaces).toEqual(["browser"]);
  });

  it("alternar muda o painel para a superfície da aba; do navegador, tira o destaque flutuante", () => {
    openColumnTab("browser", { forceNew: true });
    openColumnTab("files");
    useChatStore.setState({ browserFloating: true });
    activateColumnTab(state().columnTabs[0]!.id);
    expect(state().panel).toBe("browser");
    expect(state().browserFloating).toBe(false);
    activateColumnTab("nao-existe");
    expect(state().panel).toBe("browser");
  });

  it("fechar a ativa mostra a vizinha; fechar a última deixa o painel aberto no estado vazio", () => {
    openColumnTab("files");
    openColumnTab("diff");
    openColumnTab("pr");
    const [files, diff, pr] = state().columnTabs.map((t) => t.id) as [string, string, string];
    activateColumnTab(diff);
    closeColumnTab(diff);
    expect(state().panel).toBe("pr");
    closeColumnTab(pr);
    expect(state().panel).toBe("files");
    closeColumnTab(files);
    expect(state().panel).toBe("empty");
    expect(state().columnActive).toBeNull();
    expect(state().surfaces).toEqual([]);
  });

  it("fechar outra aba não muda a vista; fechar com o painel fechado não o reabre e ajusta a aba lembrada", () => {
    openColumnTab("files");
    openColumnTab("diff");
    const [files, diff] = state().columnTabs.map((t) => t.id) as [string, string];
    closeColumnTab(files);
    expect(state().panel).toBe("diff");
    setRightPanel(null);
    expect(state().lastPanel).toBe("diff");
    closeColumnTab(diff);
    expect(state().panel).toBeNull();
    expect(state().lastPanel).toBeNull();
  });

  it("fechar uma de duas abas de navegador mantém a superfície aberta; só a última a tira de `surfaces`", () => {
    openColumnTab("browser", { forceNew: true });
    openColumnTab("browser", { forceNew: true });
    const [a, b] = state().columnTabs.map((t) => t.id) as [string, string];
    closeColumnTab(a);
    expect(state().surfaces).toEqual(["browser"]);
    closeColumnTab(b);
    expect(state().surfaces).toEqual([]);
  });

  it("reordenar e guardar o recurso por escopo", () => {
    openColumnTab("files");
    openColumnTab("diff");
    const [files, diff] = state().columnTabs.map((t) => t.id) as [string, string];
    moveColumnTab(diff, 0);
    expect(state().columnTabs.map((t) => t.id)).toEqual([diff, files]);
    setColumnTabResource(files, "user|/repo", "view-1");
    setColumnTabResource(files, "tab:x|/repo", "view-2");
    expect(state().columnTabs.find((t) => t.id === files)!.resources).toEqual({ "user|/repo": "view-1", "tab:x|/repo": "view-2" });
  });
});
