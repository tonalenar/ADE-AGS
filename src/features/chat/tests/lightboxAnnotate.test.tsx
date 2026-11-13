// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ saved: [] as Array<{ path: string; data: string }> }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]), convertFileSrc: (path: string) => `asset://${path}` }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: () => Promise.resolve(), openPath: () => Promise.resolve() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key}${JSON.stringify(o)}` : key), i18n: { language: "pt-BR" } }),
}));
vi.mock("../attachments/ipc", () => ({
  readImage: (path: string) => Promise.resolve({ mime: "image/png", dataUrl: `data:image/png;base64,${btoa(path)}` }),
  backgroundRemovalAvailable: () => Promise.resolve(false),
  removeImageBackground: (path: string) => Promise.resolve(path),
  saveAnnotatedCopy: (path: string, data: string) => { mocks.saved.push({ path, data }); return Promise.resolve(path.replace(/\.png$/, "-anotado.png")); },
}));
vi.mock("@/features/terminal/ipc", () => ({ savePastedImage: () => Promise.resolve("/tmp/marked.png") }));

import { Lightbox, type LightboxImage } from "../attachments/Lightbox";
import { annotatedName, eraseAt, hitsAnnotation, isDegenerate, moveAnnotation, nextStepNumber, resizeAnnotation, type Annotation } from "../attachments/annotations";

describe("modelo das marcações", () => {
  const arrow: Annotation = { kind: "arrow", color: "red-500", width: 0.004, from: { x: 0.1, y: 0.1 }, to: { x: 0.9, y: 0.9 } };
  const step = (n: number): Annotation => ({ kind: "step", color: "red-500", width: 0.004, at: { x: 0.5, y: 0.5 }, n });

  it("o número dos passos continua do maior, mesmo depois de apagar o meio", () => {
    expect(nextStepNumber([])).toBe(1);
    expect(nextStepNumber([step(1), step(3)])).toBe(4);
  });

  it("a cópia anotada vira PNG com o sufixo -anotado", () => {
    expect(annotatedName("print.jpg")).toBe("print-anotado.png");
    expect(annotatedName("tela.final.png")).toBe("tela.final-anotado.png");
    expect(annotatedName("sem-extensao")).toBe("sem-extensao-anotado.png");
  });

  it("a borracha apaga só a marca de cima que o ponto toca", () => {
    const rect: Annotation = { kind: "rect", color: "green-500", width: 0.004, from: { x: 0.4, y: 0.4 }, to: { x: 0.6, y: 0.6 } };
    expect(hitsAnnotation(arrow, { x: 0.5, y: 0.5 })).toBe(true);
    expect(hitsAnnotation(arrow, { x: 0.9, y: 0.1 })).toBe(false);
    const result = eraseAt([arrow, rect], { x: 0.5, y: 0.5 });
    expect(result.removed).toBe(rect);
    expect(result.marks).toEqual([arrow]);
    expect(eraseAt([arrow], { x: 0.05, y: 0.95 }).removed).toBeNull();
  });

  it("um clique sem arrastar não vira marca", () => {
    expect(isDegenerate({ ...arrow, to: arrow.from })).toBe(true);
    expect(isDegenerate({ kind: "pen", color: "red-500", width: 0.004, points: [{ x: 0, y: 0 }] })).toBe(true);
    expect(isDegenerate({ kind: "text", color: "red-500", width: 0.004, at: { x: 0, y: 0 }, text: "  " })).toBe(true);
    expect(isDegenerate(arrow)).toBe(false);
  });

  it("move uma marca selecionada e redimensiona sua caixa pela alça", () => {
    const rect: Annotation = { kind: "rect", color: "red-500", width: 0.004, from: { x: 0.2, y: 0.2 }, to: { x: 0.6, y: 0.6 } };
    const moved = moveAnnotation(rect, 0.1, -0.05);
    expect(moved).toMatchObject({ kind: "rect" });
    if (moved.kind === "rect") { expect(moved.from.x).toBeCloseTo(0.3); expect(moved.from.y).toBeCloseTo(0.15); expect(moved.to.x).toBeCloseTo(0.7); expect(moved.to.y).toBeCloseTo(0.55); }
    expect(resizeAnnotation(rect, "se", { x: 0.8, y: 0.7 }, 100, 100)).toMatchObject({ from: rect.from, to: { x: 0.8, y: 0.7 } });
  });
});

let root: Root;
let host: HTMLDivElement;
const IMAGES: LightboxImage[] = [
  { path: "/p/a.png", name: "a.png", preview: null, kind: "image" },
  { path: "/p/b.png", name: "b.png", preview: null, kind: "image" },
  { path: "/p/clip.mp4", name: "clip.mp4", preview: null, kind: "video" },
];
const dialog = () => document.querySelector("[role=dialog]") as HTMLElement;
const button = (label: string) => dialog().querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const key = (k: string) => act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
const pointer = (type: string, x: number, y: number) => act(async () => {
  dialog().querySelector("svg[aria-label='chat.attach.lightbox.markLayer']")!.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, buttons: 1 }));
});

async function open(index = 0, images = IMAGES) {
  await act(async () => { root.render(<Lightbox images={images} index={index} onIndex={() => undefined} onClose={() => undefined} />); });
  await settle();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.saved = [];
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.spyOn(HTMLImageElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("visualizador com marcações", () => {
  it("a coluna da esquerda mostra miniaturas de verdade, não números", async () => {
    await open(0, IMAGES.slice(0, 2));
    const thumbs = [...dialog().querySelectorAll("[aria-label='chat.attach.lightbox.gallery'] button")];
    expect(thumbs).toHaveLength(2);
    expect(thumbs.every((thumb) => thumb.querySelector("img")?.getAttribute("src")?.startsWith("data:image/png"))).toBe(true);
    expect(thumbs.map((thumb) => thumb.textContent)).toEqual(["", ""]);
    expect(thumbs[0]!.getAttribute("aria-current")).toBe("true");
    // A imagem aberta continua sendo a primeira <img> do diálogo.
    expect(dialog().querySelector("img")!.alt).toBe("a.png");
  });

  it("vídeo na coluna mostra o primeiro quadro", async () => {
    await open(2);
    await act(async () => { const select = dialog().querySelector("select") as HTMLSelectElement; select.value = "all"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    const video = dialog().querySelector("[aria-label='chat.attach.lightbox.gallery'] video");
    expect(video?.getAttribute("src")).toBe("asset:///p/clip.mp4#t=0.1");
  });

  it("a dock só tem botões de ícone com tooltip, sem rótulo que quebre linha", async () => {
    await open();
    const toolbar = dialog().querySelector("[role=toolbar]")!;
    const buttons = [...toolbar.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(10);
    expect(buttons.every((b) => b.textContent === "" && b.getAttribute("title"))).toBe(true);
    expect(button("chat.attach.lightbox.tool.rect").getAttribute("title")).toBe("chat.attach.lightbox.tool.rect (R)");
  });

  it("atalho escolhe a ferramenta; arrastar desenha; desfazer e refazer funcionam", async () => {
    await open();
    button("chat.attach.lightbox.close").focus();
    await key("r");
    expect(button("chat.attach.lightbox.tool.rect").getAttribute("aria-pressed")).toBe("true");
    await pointer("pointerdown", 10, 10);
    await pointer("pointermove", 60, 40);
    await pointer("pointerup", 60, 40);
    expect(dialog().querySelectorAll("svg[aria-label='chat.attach.lightbox.markLayer'] rect")).toHaveLength(1);
    await act(async () => { button("chat.attach.lightbox.undo").click(); });
    expect(dialog().querySelectorAll("svg[aria-label='chat.attach.lightbox.markLayer'] rect")).toHaveLength(0);
    await act(async () => { button("chat.attach.lightbox.redo").click(); });
    expect(dialog().querySelectorAll("svg[aria-label='chat.attach.lightbox.markLayer'] rect")).toHaveLength(1);
  });

  it("seleciona e arrasta a marca; desfazer restaura a posição", async () => {
    await open(0, IMAGES.slice(0, 1));
    await key("r");
    await pointer("pointerdown", 10, 10); await pointer("pointermove", 60, 40); await pointer("pointerup", 60, 40);
    const layer = dialog().querySelector("svg[aria-label='chat.attach.lightbox.markLayer']")!;
    expect(button("chat.attach.lightbox.tool.select").getAttribute("aria-pressed")).toBe("true");
    await pointer("pointerdown", 20, 20); await pointer("pointermove", 30, 30); await pointer("pointerup", 30, 30);
    expect(Number(layer.querySelector("rect")?.getAttribute("x"))).toBeCloseTo(0.2);
    await act(async () => { button("chat.attach.lightbox.undo").click(); });
    expect(layer.querySelector("rect")?.getAttribute("x")).toBe("0.1");
  });

  it("redimensiona a marca pela alça do canto e desfaz a alteração", async () => {
    await open(0, IMAGES.slice(0, 1));
    await key("r");
    await pointer("pointerdown", 10, 10); await pointer("pointermove", 60, 40); await pointer("pointerup", 60, 40);
    await pointer("pointerdown", 20, 20); await pointer("pointerup", 20, 20);
    const layer = dialog().querySelector("svg[aria-label='chat.attach.lightbox.markLayer']")!;
    const handle = layer.querySelector("circle[data-handle='se']")!;
    const x = Number(handle.getAttribute("cx")) * 100, y = Number(handle.getAttribute("cy")) * 100;
    await pointer("pointerdown", x, y); await pointer("pointermove", x + 10, y + 10); await pointer("pointerup", x + 10, y + 10);
    expect(Number(layer.querySelector("rect")?.getAttribute("width"))).toBeCloseTo(0.6);
    await act(async () => { button("chat.attach.lightbox.undo").click(); });
    expect(Number(layer.querySelector("rect")?.getAttribute("width"))).toBeCloseTo(0.5);
  });

  it("a ferramenta de texto abre um campo que continua focado depois do clique e grava o texto", async () => {
    await open(0, IMAGES.slice(0, 1));
    await key("T");
    // Como no navegador: se o pointerdown não for cancelado, o mousedown seguinte tira o foco do campo novo.
    const layer = dialog().querySelector("svg[aria-label='chat.attach.lightbox.markLayer']")!;
    const down = new PointerEvent("pointerdown", { clientX: 30, clientY: 40, bubbles: true, cancelable: true, buttons: 1 });
    await act(async () => { layer.dispatchEvent(down); });
    if (!down.defaultPrevented) await act(async () => { (document.activeElement as HTMLElement | null)?.blur(); });
    const input = dialog().querySelector("input[aria-label='chat.attach.lightbox.textPrompt']") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Olá");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { input!.form!.requestSubmit(); });
    expect([...layer.querySelectorAll("text")].map((node) => node.textContent)).toContain("Olá");
  });

  it("a ferramenta de passos numera 1, 2, 3 e a borracha apaga", async () => {
    await open();
    await act(async () => { button("chat.attach.lightbox.tool.step").click(); });
    await pointer("pointerdown", 20, 20);
    await act(async () => { button("chat.attach.lightbox.tool.step").click(); });
    await pointer("pointerdown", 80, 80);
    expect([...dialog().querySelectorAll("svg[aria-label='chat.attach.lightbox.markLayer'] text")].map((t) => t.textContent)).toEqual(["1", "2"]);
    await act(async () => { button("chat.attach.lightbox.tool.eraser").click(); });
    await pointer("pointerdown", 20, 20);
    expect([...dialog().querySelectorAll("svg[aria-label='chat.attach.lightbox.markLayer'] text")].map((t) => t.textContent)).toEqual(["2"]);
    await act(async () => { button("chat.attach.lightbox.tool.step").click(); });
    await pointer("pointerdown", 50, 50);
    expect([...dialog().querySelectorAll("svg[aria-label='chat.attach.lightbox.markLayer'] text")].map((t) => t.textContent)).toEqual(["2", "3"]);
  });

  it("salvar cópia anotada grava ao lado do original pelo comando seguro", async () => {
    await open();
    await act(async () => { button("chat.attach.lightbox.saveCopy").click(); });
    await settle();
    expect(mocks.saved).toHaveLength(1);
    expect(mocks.saved[0]!.path).toBe("/p/a.png");
    expect(mocks.saved[0]!.data.startsWith("data:")).toBe(false);
    expect(dialog().querySelector("[role=status]")?.textContent).toContain("a-anotado.png");
  });
});
