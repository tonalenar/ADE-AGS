// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { installScaledMouseFix, unscaledPoint } from "../scaledMouse";

describe("mouse da terminal escalada", () => {
  it("desfaz a escala a partir da origem e deixa 100 % como está", () => {
    expect(unscaledPoint({ x: 187, y: 274 }, { left: 100, top: 100 }, 0.87)).toEqual({ x: 200, y: 300 });
    expect(unscaledPoint({ x: 150, y: 150 }, { left: 100, top: 100 }, 1)).toEqual({ x: 150, y: 150 });
    expect(unscaledPoint({ x: 150, y: 150 }, { left: 100, top: 100 }, 0)).toEqual({ x: 150, y: 150 });
  });

  let off: (() => void) | null = null;
  afterEach(() => { off?.(); off = null; document.body.innerHTML = ""; });

  it("o xterm recebe o ponto corrigido, também no arrasto que sai da terminal", () => {
    document.body.innerHTML = `<div id="host" data-term-scale="0.5"><div class="xterm-screen"><span id="cell"></span></div></div><div id="out"></div>`;
    const screen = document.querySelector(".xterm-screen") as HTMLElement;
    screen.getBoundingClientRect = () => ({ left: 10, top: 20, right: 0, bottom: 0, width: 0, height: 0, x: 10, y: 20, toJSON() {} });
    off = installScaledMouseFix(window);
    const seen: Array<[string, number, number]> = [];
    const log = (e: MouseEvent) => seen.push([e.type, e.clientX, e.clientY]);
    screen.addEventListener("mousedown", log);
    document.addEventListener("mousemove", log);
    document.addEventListener("mouseup", log);

    document.getElementById("cell")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 30, clientY: 40, button: 0 }));
    document.getElementById("out")!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 60, clientY: 70, buttons: 1 }));
    document.getElementById("out")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 60, clientY: 70 }));
    // Depois de soltar, um movimento fora não é tocado.
    document.getElementById("out")!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 60, clientY: 70 }));

    expect(seen).toEqual([["mousedown", 50, 60], ["mousemove", 110, 120], ["mouseup", 110, 120], ["mousemove", 60, 70]]);
  });
});
