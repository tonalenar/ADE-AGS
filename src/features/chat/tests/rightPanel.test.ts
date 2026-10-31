// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import { addSurface, forgetLastPanel, hostLabel, openTeamPanelFocused, parsePanel, removeSurface, setRightPanel, toggleRightPanel, useChatStore } from "@/features/chat/store";

describe("painel direito: as superfícies (prancheta 8)", () => {
  beforeEach(() => useChatStore.setState({ panel: null, surfaces: ["browser"] }));

  it("abrir pelo + acrescenta no fim e mostra; abrir de novo não repete", () => {
    addSurface("ios");
    addSurface("ios");
    addSurface("android");
    expect(useChatStore.getState().surfaces).toEqual(["browser", "ios", "android"]);
    expect(useChatStore.getState().panel).toBe("android");
  });

  it("fechar a que está à vista volta ao Diff; fechar outra não muda a vista", () => {
    setRightPanel("browser");
    removeSurface("browser");
    expect(useChatStore.getState().panel).toBe("diff");
    addSurface("files");
    setRightPanel("diff");
    removeSurface("files");
    expect(useChatStore.getState().panel).toBe("diff");
  });
});

describe("painel direito: abrir sem superfície", () => {
  beforeEach(() => useChatStore.setState({ panel: null, lastPanel: null, panelFocus: 0, surfaces: [] }));

  it("a primeira abertura mostra o Resumo (a superfície padrão); uma superfície aberta a troca", () => {
    toggleRightPanel();
    expect(useChatStore.getState().panel).toBe("summary");
    addSurface("browser");
    expect(useChatStore.getState().panel).toBe("browser");
  });

  it("fechar e reabrir volta na aba que estava à vista; fechar sem aba lembrada não inventa uma", () => {
    addSurface("files");
    toggleRightPanel();
    expect(useChatStore.getState().panel).toBeNull();
    toggleRightPanel();
    expect(useChatStore.getState().panel).toBe("files");
    setRightPanel(null);
    setRightPanel(null);
    expect(useChatStore.getState().lastPanel).toBe("files");
    forgetLastPanel();
    toggleRightPanel();
    expect(useChatStore.getState().panel).toBe("summary");
    toggleRightPanel();
    // Fechar o Resumo o lembra (reabrir volta nele, que já é o padrão).
    expect(useChatStore.getState().lastPanel).toBe("summary");
  });

  it("o atalho do Time abre a aba e pede o foco", () => {
    openTeamPanelFocused();
    expect(useChatStore.getState().panel).toBe("team");
    expect(useChatStore.getState().panelFocus).toBe(1);
  });
});

describe("hostLabel", () => {
  it("o host com a porta; nada sem endereço válido", () => {
    expect(hostLabel("http://localhost:1420/settings")).toBe("localhost:1420");
    expect(hostLabel("https://example.com/a")).toBe("example.com");
    expect(hostLabel("")).toBeNull();
    expect(hostLabel("não é url")).toBeNull();
  });
});

describe("largura do painel direito (arrastando a borda)", () => {
  it("fica entre o mínimo e o que deixa a conversa com o mínimo dela", async () => {
    const { clampPanelWidth, PANEL_W } = await import("@/features/chat/store");
    expect(clampPanelWidth(100, 1400)).toBe(PANEL_W.min);
    expect(clampPanelWidth(700, 1400)).toBe(700);
    expect(clampPanelWidth(1300, 1400)).toBe(1400 - PANEL_W.conversationMin);
    expect(clampPanelWidth(900, 800)).toBe(PANEL_W.min);
    expect(clampPanelWidth(Number.NaN, 1400)).toBe(PANEL_W.initial);
  });
});

describe("o painel lembrado", () => {
  it("abre no Resumo sem nada guardado ou com lixo; 'none' é o painel que a pessoa fechou", () => {
    expect(parsePanel(null)).toBe("summary");
    expect(parsePanel("lixo")).toBe("summary");
    expect(parsePanel("empty")).toBe("summary");
    expect(parsePanel("none")).toBeNull();
    expect(parsePanel("diff")).toBe("diff");
  });
  it("a escolha (inclusive fechar) é gravada", () => {
    setRightPanel("diff");
    expect(localStorage.getItem("ags.chat.panel")).toBe("diff");
    setRightPanel(null);
    expect(localStorage.getItem("ags.chat.panel")).toBe("none");
    setRightPanel("summary");
    expect(localStorage.getItem("ags.chat.panel")).toBe("summary");
  });
});
