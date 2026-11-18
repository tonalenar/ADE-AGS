// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { installScaledMouseFix } from "../scaledMouse";

describe("origem do xterm escalado", () => {
  it("é medida uma vez por quadro, e não a cada mousemove", () => {
    const host = document.createElement("div");
    host.dataset.termScale = "0.5";
    const tela = document.createElement("div");
    tela.className = "xterm-screen";
    host.appendChild(tela);
    document.body.appendChild(host);
    const medir = vi.spyOn(tela, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));

    const desligar = installScaledMouseFix(window);
    for (let i = 0; i < 20; i++) {
      tela.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: i, clientY: i }));
    }
    expect(medir).toHaveBeenCalledTimes(1);
    desligar();
    host.remove();
  });
});
