import { describe, expect, it } from "vitest";

import { clampAnchor, formatSendText, pinPosition, relativePoint, sendPayload, threadsOf } from "../anchor";

describe("comentários ancorados", () => {
  it("a âncora fica nos 10 últimos segmentos e em 1024 caracteres", () => {
    const deep = Array.from({ length: 14 }, (_, i) => `div:nth-of-type(${i + 1})`).join(" > ");
    const a = clampAnchor(deep)!;
    expect(a.split(" > ")).toHaveLength(10);
    expect(a.startsWith("div:nth-of-type(5)")).toBe(true);
    expect(clampAnchor("")).toBeNull();
    expect(clampAnchor(null)).toBeNull();
    expect(clampAnchor(`div#${"x".repeat(2000)}`)!.length).toBeLessThanOrEqual(1024);
  });

  it("ponto relativo preso em 0–1", () => {
    expect(relativePoint(15, 30, { x: 10, y: 10, w: 10, h: 40 })).toEqual({ x: 0.5, y: 0.5 });
    expect(relativePoint(-5, 99, { x: 0, y: 0, w: 10, h: 10 })).toEqual({ x: 0, y: 1 });
  });

  it("o pino segue o elemento; sem a caixa dele, vale relativo à prancheta", () => {
    const board = { x: 100, y: 100, w: 400, h: 200 };
    const c = { id: "c", artboardId: "b", anchor: "p", pointX: 0.5, pointY: 0.5 };
    expect(pinPosition(c, board, { x: 10, y: 20, w: 40, h: 10 })).toEqual({ x: 130, y: 125 });
    expect(pinPosition(c, board, null)).toEqual({ x: 300, y: 200 });
    expect(pinPosition({ ...c, anchor: null, pointX: 0, pointY: 1 }, board, null)).toEqual({ x: 100, y: 300 });
  });

  it("fios por parentId, em ordem; resposta de resposta vai para a raiz e órfã vira raiz", () => {
    const c = (id: string, parentId: string | null, createdAt: number) => ({ id, parentId, createdAt, resolved: false });
    const out = threadsOf([c("r2", null, 5), c("a", "r1", 3), c("r1", null, 1), c("b", "a", 4), c("o", "sumiu", 2)]);
    expect(out.map((t) => t.root.id)).toEqual(["r1", "o", "r2"]);
    expect(out[0].replies.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("o envio ao agente corta rótulo/trecho/pedido e diz onde mexer", () => {
    const p = sendPayload("x".repeat(500), "  muito   espaço ", "y".repeat(3000));
    expect(p.label).toHaveLength(120);
    expect(p.selectedText).toBe("muito espaço");
    expect(p.request).toHaveLength(2000);
    const text = formatSendText(sendPayload("botão “Entrar”", "Entrar", "maior"), { designTitle: "Login", designId: "d1", boardTitle: "Tela", boardId: "b1", anchor: "button#go" });
    expect(text).toContain("prancheta \"Tela\" (b1)");
    expect(text).toContain("Elemento: button#go");
    expect(text).toContain("Pedido: maior");
  });
});
