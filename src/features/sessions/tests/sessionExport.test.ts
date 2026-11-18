import { describe, expect, it, vi } from "vitest";

import { pickAndExport } from "../sessionExport";

describe("pickAndExport", () => {
  it("propaga a falha do diálogo de salvar para o caller tratar", async () => {
    const write = vi.fn();
    await expect(pickAndExport(async () => {
      throw new Error("dialog");
    }, write)).rejects.toThrow("dialog");
    expect(write).not.toHaveBeenCalled();
  });

  it("cancela sem gravar se o destino veio vazio", async () => {
    const write = vi.fn();
    await expect(pickAndExport(async () => null, write)).resolves.toBe("cancel");
    expect(write).not.toHaveBeenCalled();
  });
});
