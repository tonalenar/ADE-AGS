// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ revealed: [] as string[], dragHandler: null as null | ((e: { payload: unknown }) => void), terminalAt: null as string | null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: (p: string) => { mocks.revealed.push(p); return Promise.resolve(); } }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ onDragDropEvent: (h: (e: { payload: unknown }) => void) => { mocks.dragHandler = h; return Promise.resolve(() => undefined); } }),
}));
vi.mock("@/features/terminal/useFileDropToTerminal", () => ({ terminalTabAt: () => mocks.terminalAt }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key}${JSON.stringify(o)}` : key), i18n: { language: "pt-BR" } }),
}));
vi.mock("../attachments/ipc", () => ({
  inspectPaths: () => Promise.resolve([]),
  readImage: (path: string) => (path.includes("sumiu") ? Promise.reject(new Error("não existe")) : Promise.resolve({ mime: "image/png", dataUrl: `data:image/png;base64,${path.length}` })),
}));

import { AttachmentStrip, type ShownAttachment } from "../attachments/AttachmentStrip";
import { activeDropSink, insideRect, registerDropSink, useDropHighlight } from "../attachments/dropRegistry";
import { DropOverlay } from "../attachments/DropOverlay";
import { insideCwd } from "../attachments/openAttachment";
import { messageFor, threadMessage, tuiMessage } from "../attachments/send";
import { stepIndex } from "../attachments/Lightbox";
import { useChatFileDrop } from "../attachments/useChatFileDrop";
import { pathsFromUriList } from "../attachments/useAttachments";
import { attachmentBlock, type Attachment } from "../attachments/attachModel";
import { PersonBubble } from "../timeline/Bubbles";
import { useTabsStore } from "@/features/tabs/store";

let root: Root;
let host: HTMLDivElement;
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });
const key = (k: string) => act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
const dialog = () => document.querySelector("[role=dialog]") as HTMLElement | null;

const IMAGES: ShownAttachment[] = [
  { path: "/p/a.png", name: "a.png", kind: "image", size: 10 },
  { path: "/p/b.png", name: "b.png", kind: "image", size: 10 },
  { path: "/p/rel.pdf", name: "rel.pdf", kind: "file", size: 2_100_000 },
  { path: "/p/dir", name: "dir", kind: "folder", size: null },
];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.revealed = []; mocks.dragHandler = null; mocks.terminalAt = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); document.body.innerHTML = ""; });

describe("a fileira de miniaturas", () => {
  it("imagem = cartão com a prévia; arquivo e pasta = chip com nome e tamanho", async () => {
    await act(async () => { root.render(<AttachmentStrip items={IMAGES} />); });
    expect(host.querySelectorAll("img")).toHaveLength(2);
    expect(host.textContent).toContain("rel.pdf");
    expect(host.textContent).toContain("2.0 MB");
    expect(host.textContent).toContain("chat.attach.folder");
  });

  it("imagem que sumiu do disco vira 'indisponível', sem quebrar", async () => {
    await act(async () => { root.render(<AttachmentStrip items={[{ path: "/p/sumiu.png", name: "sumiu.png", kind: "image", size: 1 }]} />); });
    expect(host.textContent).toContain("chat.attach.missing");
  });

  it("o × só existe quando se pode remover e chama onRemove com o caminho", async () => {
    const removed: string[] = [];
    await act(async () => { root.render(<AttachmentStrip items={IMAGES} />); });
    expect(host.querySelector("[aria-label^='chat.attach.remove']")).toBeNull();
    await act(async () => { root.render(<AttachmentStrip items={IMAGES} onRemove={(p) => removed.push(p)} />); });
    await click(host.querySelector("[aria-label='chat.attach.remove{\"name\":\"rel.pdf\"}']"));
    expect(removed).toEqual(["/p/rel.pdf"]);
  });

  it("o × aparece com o foco do teclado, não só com o mouse", async () => {
    await act(async () => { root.render(<AttachmentStrip items={IMAGES} onRemove={() => undefined} />); });
    const x = host.querySelector("[aria-label^='chat.attach.remove']") as HTMLElement;
    expect(x.className).toContain("focus:opacity-100");
    expect(x.className).toContain("group-focus-within:opacity-100");
  });

  it("arquivo fora da pasta da conversa revela no Finder; uma pasta também", async () => {
    await act(async () => { root.render(<AttachmentStrip items={IMAGES} cwd="/repo" />); });
    await click(host.querySelector("[aria-label='chat.attach.openFile{\"name\":\"rel.pdf\"}']"));
    await click(host.querySelector("[aria-label='chat.attach.openFile{\"name\":\"dir\"}']"));
    expect(mocks.revealed).toEqual(["/p/rel.pdf", "/p/dir"]);
  });
});

describe("o visualizador (lightbox)", () => {
  it("clicar na imagem a amplia num diálogo, com o foco no fechar", async () => {
    await act(async () => { root.render(<AttachmentStrip items={IMAGES} />); });
    await click(host.querySelector("[aria-label='chat.attach.zoom{\"name\":\"b.png\"}']"));
    expect(dialog()).not.toBeNull();
    expect(dialog()!.getAttribute("aria-modal")).toBe("true");
    expect(dialog()!.getAttribute("aria-label")).toContain('"index":2,"count":2,"name":"b.png"');
    expect(document.activeElement?.getAttribute("aria-label")).toBe("chat.attach.lightbox.close");
  });

  it("Esc fecha e o foco volta para quem abriu", async () => {
    await act(async () => { root.render(<AttachmentStrip items={IMAGES} />); });
    const opener = host.querySelector("[aria-label='chat.attach.zoom{\"name\":\"a.png\"}']") as HTMLElement;
    opener.focus();
    await click(opener);
    await key("Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("clicar fora da imagem fecha; clicar na imagem não", async () => {
    await act(async () => { root.render(<AttachmentStrip items={IMAGES} />); });
    await click(host.querySelector("[aria-label='chat.attach.zoom{\"name\":\"a.png\"}']"));
    await act(async () => { dialog()!.querySelector("img")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(dialog()).not.toBeNull();
    await act(async () => { dialog()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(dialog()).toBeNull();
  });

  it("as setas passam de uma imagem para outra e param nas pontas", async () => {
    await act(async () => { root.render(<AttachmentStrip items={IMAGES} />); });
    await click(host.querySelector("[aria-label='chat.attach.zoom{\"name\":\"a.png\"}']"));
    expect(dialog()!.querySelector("img")!.alt).toBe("a.png");
    await key("ArrowRight");
    expect(dialog()!.querySelector("img")!.alt).toBe("b.png");
    await key("ArrowRight");
    expect(dialog()!.querySelector("img")!.alt).toBe("b.png");
    await key("ArrowLeft");
    expect(dialog()!.querySelector("img")!.alt).toBe("a.png");
  });

  it("com uma imagem só não há setas", async () => {
    await act(async () => { root.render(<AttachmentStrip items={[IMAGES[0]!]} />); });
    await click(host.querySelector("[aria-label='chat.attach.zoom{\"name\":\"a.png\"}']"));
    expect(dialog()!.querySelector("[aria-label='chat.attach.lightbox.next']")).toBeNull();
  });

  it("stepIndex não passa das pontas", () => {
    expect(stepIndex(0, -1, 3)).toBe(0);
    expect(stepIndex(2, 1, 3)).toBe(2);
    expect(stepIndex(1, 1, 3)).toBe(2);
  });
});

describe("a mensagem enviada mostra as miniaturas acima do texto", () => {
  const atts = [{ id: "/p/a.png", path: "/p/a.png", name: "a.png", kind: "image", mime: null, size: 10, preview: null, temp: false }] as Attachment[];

  it("o bloco [Anexos] sai do balão e vira a fileira; o texto fica no balão", async () => {
    const text = `olha isso\n\n${attachmentBlock(atts)}`;
    await act(async () => { root.render(<PersonBubble text={text} />); });
    expect(host.querySelector("ul[aria-label='chat.attach.label'] img")).not.toBeNull();
    expect(host.textContent).toContain("olha isso");
    expect(host.textContent).not.toContain("[Anexos]");
    const strip = host.querySelector("ul[aria-label='chat.attach.label']")!;
    const bubble = [...host.querySelectorAll("div")].filter((d) => d.textContent === "olha isso").pop()!;
    expect(strip.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("só anexos: sem balão de texto vazio", async () => {
    await act(async () => { root.render(<PersonBubble text={attachmentBlock(atts)} />); });
    expect(host.querySelector("ul[aria-label='chat.attach.label']")).not.toBeNull();
    expect(host.querySelector(".rounded-2xl")).toBeNull();
  });

  it("mensagem sem anexos fica como sempre", async () => {
    await act(async () => { root.render(<PersonBubble text="oi" />); });
    expect(host.querySelector("ul")).toBeNull();
    expect(host.textContent).toContain("oi");
  });
});

describe("o que cada tipo de conversa recebe", () => {
  const atts = [
    { id: "a", path: "/p/a b.png", name: "a b.png", kind: "image", mime: null, size: 10, preview: null, temp: false },
    { id: "b", path: "/p/rel.pdf", name: "rel.pdf", kind: "file", mime: null, size: 20, preview: null, temp: false },
  ] as Attachment[];

  it("conversa por protocolo: bloco com o caminho de todos no texto e as imagens também em linha", () => {
    const m = messageFor("thread:t1", "oi", atts);
    expect(m.text).toContain("oi\n\n[Anexos]");
    expect(m.text).toContain("/p/a b.png");
    expect(m.text).toContain("/p/rel.pdf");
    expect(m.images).toEqual(["/p/a b.png"]);
    expect(threadMessage("oi", [])).toEqual({ text: "oi", images: [] });
  });

  it("aba com TUI: @caminho no fim do texto, sem imagens em linha; só anexos = só os @", () => {
    useTabsStore.setState({ tabs: [{ id: "tab-1", agentId: "claude-code" }] } as never);
    expect(messageFor("tab-1", "oi", atts)).toEqual({ text: 'oi @"/p/a b.png" @/p/rel.pdf', images: [] });
    expect(tuiMessage("claude-code", "", atts)).toBe('@"/p/a b.png" @/p/rel.pdf');
    expect(tuiMessage("claude-code", "oi", [])).toBe("oi");
  });
});

describe("pasta da conversa e URLs colados", () => {
  it("só abre no painel de Arquivos o que está dentro da pasta da conversa", () => {
    expect(insideCwd("/repo", "/repo/src/a.ts")).toBe(true);
    expect(insideCwd("/repo/", "/repo/a.ts")).toBe(true);
    expect(insideCwd("/repo", "/repo2/a.ts")).toBe(false);
    expect(insideCwd("/repo", "/outro/a.ts")).toBe(false);
    expect(insideCwd(null, "/repo/a.ts")).toBe(false);
  });

  it("pathsFromUriList lê só file:// e decodifica", () => {
    expect(pathsFromUriList("file:///a/b%20c.png\r\nhttps://x.com/a.png\r\n\r\nfile:///d.pdf")).toEqual(["/a/b c.png", "/d.pdf"]);
    expect(pathsFromUriList("")).toEqual([]);
  });
});

describe("o arrasto nativo para a coluna do chat", () => {
  function Target() {
    const ref = { current: null as HTMLElement | null };
    return (
      <>
        <section ref={(el) => { ref.current = el; if (el) el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400, x: 0, y: 0, toJSON() {} }); }} />
        <Hook target={ref} />
        <DropOverlay />
      </>
    );
  }
  function Hook({ target }: { target: { current: HTMLElement | null } }) {
    useChatFileDrop(target);
    return null;
  }
  const fire = (payload: unknown) => act(async () => { mocks.dragHandler!({ payload }); });
  let received: string[][] = [];
  let off: () => void;

  beforeEach(async () => {
    received = [];
    off = registerDropSink({ addPaths: (p) => received.push(p) });
    await act(async () => { root.render(<Target />); });
  });
  afterEach(() => { off(); useDropHighlight.setState({ on: false }); });

  it("passando por cima da coluna realça 'Solte para anexar'; sair tira o realce", async () => {
    await fire({ type: "enter", paths: ["/p/a.png"], position: { x: 100, y: 100 } });
    expect(host.textContent).toContain("chat.attach.dropHint");
    await fire({ type: "leave" });
    expect(host.textContent).not.toContain("chat.attach.dropHint");
  });

  it("soltar dentro entrega os caminhos ao composer; fora, não", async () => {
    await fire({ type: "drop", paths: ["/p/a.png", "/p/dir"], position: { x: 100, y: 100 } });
    expect(received).toEqual([["/p/a.png", "/p/dir"]]);
    await fire({ type: "drop", paths: ["/p/x.png"], position: { x: 900, y: 100 } });
    expect(received).toHaveLength(1);
  });

  it("soltar sobre um terminal continua sendo do terminal (não vira anexo)", async () => {
    mocks.terminalAt = "tab-1";
    await fire({ type: "over", position: { x: 100, y: 100 } });
    expect(host.textContent).not.toContain("chat.attach.dropHint");
    await fire({ type: "drop", paths: ["/p/a.png"], position: { x: 100, y: 100 } });
    expect(received).toEqual([]);
  });

  it("sem composer à vista nada é realçado nem entregue", async () => {
    off();
    expect(activeDropSink()).toBeNull();
    await fire({ type: "over", position: { x: 100, y: 100 } });
    expect(host.textContent).not.toContain("chat.attach.dropHint");
  });

  it("insideRect confere as bordas", () => {
    const r = { left: 0, top: 0, right: 10, bottom: 10 };
    expect([insideRect(r, 0, 0), insideRect(r, 10, 10), insideRect(r, 11, 5)]).toEqual([true, true, false]);
  });
});
