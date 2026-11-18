import { describe, expect, it, vi } from "vitest";
import { createWriteFailureNotice } from "../writeFailureNotice";

describe("aviso de entrada recusada pelo terminal", () => {
  it("uma rajada de recusas avisa uma vez; uma escrita aceita reabre o aviso", () => {
    const avisar = vi.fn();
    const aviso = createWriteFailureNotice(avisar);

    aviso.recusa();
    aviso.recusa();
    aviso.recusa();
    expect(avisar).toHaveBeenCalledTimes(1);

    aviso.aceita();
    aviso.recusa();
    expect(avisar).toHaveBeenCalledTimes(2);
  });
});
