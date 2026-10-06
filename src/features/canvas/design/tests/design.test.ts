import { describe, expect, it } from "vitest";

import { allApproved, buildable, formatBuildRequest, formatQueueForAgent, pendingComments } from "../commentQueue";
import { normalizeDesign, type Artboard, type DesignComment } from "../designApi";
import { DESIGN_CSP, DESIGN_SANDBOX, PICK_MESSAGE, buildSrcdoc, parsePick } from "../srcdoc";
import { INITIAL_VIEWPORT, MAX_ZOOM, MIN_ZOOM, fitViewport, viewportReducer, zoomPercent } from "../viewport";

const board = (o: Partial<Artboard> = {}): Artboard => ({
  id: "b1", pageId: "p", title: "Convite", html: "<p>x</p>", width: 400, height: 300, x: 0, y: 0, version: 1, status: "draft", ...o,
});
const comment = (o: Partial<DesignComment> = {}): DesignComment => ({
  id: "c1", artboardId: "b1", author: "user", text: "tire a aba", selector: null, resolved: false, createdAt: 1, ...o,
});

describe("srcdoc", () => {
  it("o sandbox nunca inclui allow-same-origin", () => {
    expect(DESIGN_SANDBOX).toBe("allow-scripts");
  });
  it("a CSP corta a rede", () => {
    expect(DESIGN_CSP).toContain("default-src 'none'");
    expect(DESIGN_CSP).toContain("img-src data:");
    expect(DESIGN_CSP).not.toMatch(/https?:|connect-src/);
  });
  it("a CSP vem antes do HTML do agente", () => {
    const doc = buildSrcdoc("<h1>oi</h1>");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<h1>oi</h1>"));
  });
  it("tira meta http-equiv e base do conteúdo", () => {
    const doc = buildSrcdoc(`<meta http-equiv="refresh" content="0;url=x"><base href="https://evil"><p>ok</p>`);
    expect(doc).not.toContain("refresh");
    expect(doc).not.toContain("<base");
    expect(doc).toContain("<p>ok</p>");
  });
  it("só injeta o seletor no modo EDIT", () => {
    expect(buildSrcdoc("<p/>")).not.toContain(PICK_MESSAGE);
    expect(buildSrcdoc("<p/>", { picker: true })).toContain(PICK_MESSAGE);
  });
  it("parsePick valida a mensagem do iframe", () => {
    expect(parsePick({ type: PICK_MESSAGE, selector: "div > p:nth-of-type(1)", text: "oi" })).toEqual({ selector: "div > p:nth-of-type(1)", text: "oi" });
    expect(parsePick({ type: "outro", selector: "p" })).toBeNull();
    expect(parsePick({ type: PICK_MESSAGE, selector: 3 })).toBeNull();
    expect(parsePick({ type: PICK_MESSAGE, selector: "" })).toBeNull();
    expect(parsePick({ type: PICK_MESSAGE, selector: "a".repeat(501) })).toBeNull();
    expect(parsePick(null)).toBeNull();
  });
});

describe("viewport", () => {
  it("pan soma o deslocamento", () => {
    expect(viewportReducer(INITIAL_VIEWPORT, { type: "pan", dx: 10, dy: -5 })).toEqual({ zoom: 1, x: 10, y: -5 });
  });
  it("zoom mantém fixo o ponto sob o cursor", () => {
    const v = viewportReducer({ zoom: 1, x: 20, y: 30 }, { type: "zoomBy", factor: 2, cx: 100, cy: 100 });
    expect(v.zoom).toBe(2);
    // ponto do mundo sob (100,100) antes: (80,70); depois deve continuar em (100,100)
    expect(80 * v.zoom + v.x).toBeCloseTo(100);
    expect(70 * v.zoom + v.y).toBeCloseTo(100);
  });
  it("limita o zoom", () => {
    expect(viewportReducer(INITIAL_VIEWPORT, { type: "zoomTo", zoom: 99, cx: 0, cy: 0 }).zoom).toBe(MAX_ZOOM);
    expect(viewportReducer(INITIAL_VIEWPORT, { type: "zoomTo", zoom: 0.001, cx: 0, cy: 0 }).zoom).toBe(MIN_ZOOM);
  });
  it("mostra o zoom em %", () => {
    expect(zoomPercent({ zoom: 0.71, x: 0, y: 0 })).toBe("71%");
  });
  it("reset volta ao início", () => {
    expect(viewportReducer({ zoom: 2, x: 5, y: 5 }, { type: "reset" })).toEqual(INITIAL_VIEWPORT);
  });
  it("fit enquadra as pranchetas dentro da área", () => {
    const v = fitViewport([{ x: 0, y: 0, w: 1000, h: 500 }, { x: 1200, y: 0, w: 1000, h: 500 }], 1000, 600);
    expect(v.zoom).toBeLessThan(1);
    expect(2200 * v.zoom + v.x).toBeLessThanOrEqual(1000);
    expect(v.x).toBeGreaterThanOrEqual(0);
  });
  it("fit sem pranchetas não quebra", () => {
    expect(fitViewport([], 800, 600)).toEqual(INITIAL_VIEWPORT);
  });
});

describe("fila de comentários", () => {
  it("só entram comentários do usuário não resolvidos, em ordem", () => {
    const q = pendingComments([
      comment({ id: "b", createdAt: 5 }), comment({ id: "a", createdAt: 2 }),
      comment({ id: "x", resolved: true }), comment({ id: "y", author: "agent" }),
    ]);
    expect(q.map((c) => c.id)).toEqual(["a", "b"]);
  });
  it("formata um bloco por prancheta com o seletor", () => {
    const text = formatQueueForAgent("App", [board(), board({ id: "b2", title: "Vazia" })], [comment({ selector: "nav > a:nth-of-type(2)" })]);
    expect(text).toContain('Prancheta "Convite"');
    expect(text).toContain("[nav > a:nth-of-type(2)] tire a aba");
    expect(text).not.toContain("Vazia");
  });
  it("só pranchetas aprovadas são construídas", () => {
    const all = [board({ id: "1", status: "approved" }), board({ id: "2" }), board({ id: "3", status: "rejected" })];
    expect(buildable(all).map((b) => b.id)).toEqual(["1"]);
    expect(allApproved(all)).toBe(false);
    expect(allApproved([board({ status: "approved" })])).toBe(true);
    expect(allApproved([])).toBe(false);
  });
});

describe("normalizeDesign", () => {
  it("achata páginas, pranchetas, comentários e versões do backend", () => {
    const b = (id: string, extra: object = {}) => ({ ...board({ id }), versions: [{ version: 1, html: "<p/>", title: "t" }], comments: [], ...extra });
    const raw = {
      id: "d", workspace: "w", missionId: null, ownerTabId: "tab", title: "App", status: "draft" as const,
      pages: [
        { id: "p2", designId: "d", name: "Page 2", order: 1, artboards: [b("b2")] },
        { id: "p1", designId: "d", name: "Page 1", order: 0, artboards: [b("b1", { comments: [{ id: "c", artboardId: "b1", author: "user", text: "x", selector: null, resolved: false }] })] },
      ],
    };
    const d = normalizeDesign(raw);
    expect(d.design).toEqual({ id: "d", workspace: "w", missionId: null, ownerTabId: "tab", title: "App", status: "draft" });
    expect(d.pages.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(d.artboards.map((a) => a.id)).toEqual(["b1", "b2"]);
    expect(d.comments).toHaveLength(1);
    expect(d.versions.b1).toHaveLength(1);
  });
  it("aceita design sem páginas", () => {
    expect(normalizeDesign({ id: "d", workspace: "w", missionId: null, ownerTabId: null, title: "t", status: "draft" }).artboards).toEqual([]);
  });
  it("monta o pedido de construção só com as aprovadas", () => {
    const text = formatBuildRequest("App", "d1", [board({ id: "1", title: "Ok", status: "approved" }), board({ id: "2", title: "Nao" })]);
    expect(text).toContain('"Ok"');
    expect(text).not.toContain('"Nao"');
  });
});
