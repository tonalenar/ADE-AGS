import { describe, expect, it } from "vitest";

import { DESIGN_SANDBOX } from "@/features/canvas/design/srcdoc";

import { FRAME_MSG, FRAME_SCRIPT, parseFrameMessage, resolveNavTarget, studioSrcdoc } from "../frameBridge";

const msg = (o: Record<string, unknown>) => ({ type: FRAME_MSG, ...o });

describe("ponte do iframe", () => {
  it("o srcdoc leva a CSP, o HTML e o script, e o sandbox continua sem allow-same-origin", () => {
    const doc = studioSrcdoc("<p>oi</p>");
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("<p>oi</p>");
    expect(doc).toContain(FRAME_MSG);
    expect(DESIGN_SANDBOX).not.toContain("allow-same-origin");
    expect(FRAME_SCRIPT).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(FRAME_SCRIPT).not.toContain("</script");
  });

  it("recusa o que não é nosso ou vem fora do formato", () => {
    expect(parseFrameMessage(null)).toBeNull();
    expect(parseFrameMessage({ type: "outro", kind: "wheel" })).toBeNull();
    expect(parseFrameMessage(msg({ kind: "desconhecido" }))).toBeNull();
    expect(parseFrameMessage(msg({ kind: "select", selector: "" }))).toBeNull();
    expect(parseFrameMessage(msg({ kind: "key", key: "x".repeat(50) }))).toBeNull();
    expect(parseFrameMessage(msg({ kind: "gesture", phase: "start", scale: -1 }))).toBeNull();
  });

  it("normaliza números, corta textos e prende o ponto em 0–1", () => {
    expect(parseFrameMessage(msg({ kind: "wheel", dx: "a", dy: 3, ctrl: 1 }))).toEqual({ kind: "wheel", dx: 0, dy: 3, mode: 0, ctrl: false, meta: false, cx: 0, cy: 0 });
    const pick = parseFrameMessage(msg({ kind: "pick", selector: "p", fx: 2, fy: -1, rect: { x: 1, y: 2, w: 3, h: 4 }, label: "l", text: "t".repeat(5000), bx: 5, by: 6 }));
    expect(pick).toMatchObject({ kind: "pick", selector: "p", fx: 1, fy: 0, rect: { x: 1, y: 2, w: 3, h: 4 } });
    expect(pick && pick.kind === "pick" && pick.text.length).toBe(1800);
    expect(parseFrameMessage(msg({ kind: "pick", selector: null, fx: 0.5, fy: 0.5, rect: { x: 1 } }))).toMatchObject({ selector: null, rect: null });
    expect(parseFrameMessage(msg({ kind: "select", selector: "a", elKind: "hack" }))).toMatchObject({ elKind: "other" });
    expect(parseFrameMessage(msg({ kind: "located", items: [{ id: "c1", rect: null }, { nope: 1 }] }))).toEqual({ kind: "located", items: [{ id: "c1", rect: null }] });
  });

  it("um link do protótipo aponta para a prancheta pelo id ou pelo título", () => {
    const boards = [{ id: "b1", title: "Tela Inicial" }, { id: "b2", title: "Login" }];
    expect(resolveNavTarget("Login.dc.html", boards)).toBe("b2");
    expect(resolveNavTarget("./tela-inicial.html#x", boards)).toBe("b1");
    expect(resolveNavTarget("b2", boards)).toBe("b2");
    expect(resolveNavTarget("nada.html", boards)).toBeNull();
  });
});
