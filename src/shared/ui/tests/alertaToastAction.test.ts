import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fire: vi.fn() }));
vi.mock("sweetalert2", () => ({ default: { fire: mocks.fire } }));
vi.mock("neogestify-ui-components", () => ({ activeScheme: () => "light", resolveColor: () => "#000000" }));

import { AlertaToast } from "../alerts";

beforeEach(() => mocks.fire.mockReset());

describe("AlertaToast com botão de ação", () => {
  it("sem ação, continua sem botão e nada é chamado", async () => {
    mocks.fire.mockResolvedValue({ isConfirmed: false });
    await AlertaToast("Título", "Texto", "success", 5000);
    expect(mocks.fire).toHaveBeenCalledWith(expect.objectContaining({ toast: true, showConfirmButton: false }));
  });

  it("com ação, mostra o botão com o rótulo e roda o clique ao confirmar", async () => {
    mocks.fire.mockResolvedValue({ isConfirmed: true });
    const onClick = vi.fn();
    await AlertaToast("Título", "Texto", "success", 5000, "top-end", { label: "Abrir conversa", onClick });
    expect(mocks.fire).toHaveBeenCalledWith(expect.objectContaining({ showConfirmButton: true, confirmButtonText: "Abrir conversa" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("com ação, o aviso que some sozinho não abre nada", async () => {
    mocks.fire.mockResolvedValue({ isConfirmed: false, isDismissed: true });
    const onClick = vi.fn();
    await AlertaToast("Título", "Texto", "success", 5000, "top-end", { label: "Abrir conversa", onClick });
    expect(onClick).not.toHaveBeenCalled();
  });
});
