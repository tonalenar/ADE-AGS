// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({ previewCapture: vi.fn(async () => new ArrayBuffer(8)) }));

import { freezePage } from "../annotate/capture";

afterEach(() => {
  vi.unstubAllGlobals();
});

const box = (left: number, top: number, width: number, height: number) =>
  ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) });

describe("foto da página (A194)", () => {
  it("o bitmap da janela é fechado também no caminho de erro (página fora da coluna)", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 2000, height: 1600, close })));
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => { cb(0); return 0; });
    // A página está fora da própria coluna: não há o que recortar, e a função lança.
    const page = { getBoundingClientRect: () => box(2000, 0, 100, 100) } as unknown as HTMLElement;
    const column = { getBoundingClientRect: () => box(0, 0, 300, 300) } as unknown as HTMLElement;
    await expect(freezePage(page, column)).rejects.toThrow("não está à vista");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
