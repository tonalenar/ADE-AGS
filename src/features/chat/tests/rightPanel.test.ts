import { beforeEach, describe, expect, it } from "vitest";

import { addSurface, hostLabel, removeSurface, setRightPanel, useChatStore } from "@/features/chat/store";

describe("painel direito: as superfícies (prancheta 8)", () => {
  beforeEach(() => useChatStore.setState({ panel: null, surfaces: ["browser"] }));

  it("abrir pelo + acrescenta no fim e mostra; abrir de novo não repete", () => {
    addSurface("devices");
    addSurface("devices");
    expect(useChatStore.getState().surfaces).toEqual(["browser", "devices"]);
    expect(useChatStore.getState().panel).toBe("devices");
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

describe("hostLabel", () => {
  it("o host com a porta; nada sem endereço válido", () => {
    expect(hostLabel("http://localhost:1420/settings")).toBe("localhost:1420");
    expect(hostLabel("https://example.com/a")).toBe("example.com");
    expect(hostLabel("")).toBeNull();
    expect(hostLabel("não é url")).toBeNull();
  });
});
