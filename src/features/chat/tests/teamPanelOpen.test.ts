// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import { panelForNewConversation, parsePanel, setRightPanel, useChatStore } from "../store";

describe("o painel Time só abre quando a pessoa pede", () => {
  beforeEach(() => useChatStore.setState({ panel: null, surfaces: [], lastPanel: null }));

  it("o painel lembrado nunca é o Time: reabrir o app volta com o painel fechado (as outras abas voltam como estavam)", () => {
    expect(parsePanel("team")).toBeNull();
    expect(parsePanel("ios")).toBe("ios");
    expect(parsePanel("files")).toBe("files");
    expect(parsePanel("none")).toBeNull();
    expect(parsePanel(null)).toBeNull();
  });

  it("uma conversa nova não herda o Time: com o rascunho vazio o painel fecha", () => {
    expect(panelForNewConversation("team", true)).toBeNull();
  });

  it("um time em rascunho que a pessoa montou mantém o painel Time à vista", () => {
    expect(panelForNewConversation("team", false)).toBe("team");
  });

  it("qualquer outra aba (simulador, arquivos, navegador…) e o painel fechado ficam como a pessoa deixou", () => {
    for (const panel of ["diff", "files", "browser", "design", "ios", "android", "empty"] as const) expect(panelForNewConversation(panel, true)).toBe(panel);
    expect(panelForNewConversation(null, true)).toBeNull();
  });

  it("a escolha da aba é respeitada: escolher o simulador o mantém", () => {
    setRightPanel("ios");
    expect(useChatStore.getState().panel).toBe("ios");
  });
});
