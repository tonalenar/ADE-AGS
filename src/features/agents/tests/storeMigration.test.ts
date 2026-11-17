// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ failImport: false }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "import_legacy_custom_agents") {
      if (fake.failImport) throw new Error("falha de importação");
      return undefined;
    }
    if (command === "list_custom_agents") return [];
    throw new Error(`comando inesperado: ${command}`);
  }),
}));

import { useAgentsStore } from "../store";

describe("migração de agentes legados", () => {
  beforeEach(() => {
    localStorage.clear();
    fake.failImport = false;
    useAgentsStore.setState({ customAgents: [], loaded: false });
  });

  afterEach(() => localStorage.clear());

  it("import_falho_mantem_legado", async () => {
    const raw = JSON.stringify({ state: { customAgents: [{ id: "custom", name: "Meu agente", command: "agent" }] } });
    localStorage.setItem("ade-ags-settings", raw);
    fake.failImport = true;

    await useAgentsStore.getState().loadCustomAgents();

    expect(localStorage.getItem("ade-ags-settings")).toBe(raw);
  });
});
