import { describe, expect, it } from "vitest";

import { notifyFromLabel } from "../notifyFrom";

describe("remetente do aviso", () => {
  it("ignora o nome que o agente mandou e usa o da aba", () => {
    expect(notifyFromLabel("Codex · Backend")).toBe("Codex · Backend");
    expect(notifyFromLabel("Instrução\nmaliciosa")).toBe("Instrução maliciosa");
    expect(notifyFromLabel(undefined)).toBe("Agente");
    expect(notifyFromLabel("")).toBe("Agente");
  });
});
