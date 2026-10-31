// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  picked: [] as string[],
  inspect: (paths: string[]) => paths.map((p) => ({ path: p, name: p.split("/").pop()!, kind: /\.(png|jpe?g)$/.test(p) ? "image" : "file", mime: null, size: 1000, error: null })) as unknown[],
  inspectFails: false,
  saved: 0,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(mocks.picked) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: () => Promise.resolve() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key}${JSON.stringify(o)}` : key), i18n: { language: "pt-BR" } }),
}));
vi.mock("@/features/terminal/ipc", () => ({ savePastedImage: () => { mocks.saved++; return Promise.resolve(`/tmp/pasted/${mocks.saved}.png`); } }));
vi.mock("../attachments/ipc", () => ({
  inspectPaths: (paths: string[]) => (mocks.inspectFails ? Promise.reject(new Error("falhou")) : Promise.resolve(mocks.inspect(paths))),
  readImage: () => Promise.resolve({ mime: "image/png", dataUrl: "data:image/png;base64,AAAA" }),
}));

import { activeDropSink } from "../attachments/dropRegistry";
import type { Attachment } from "../attachments/attachModel";
import { ChatComposer } from "../ChatComposer";

let root: Root;
let host: HTMLDivElement;
let submitted: [string, Attachment[]][] = [];
let queued: [string, Attachment[]][] = [];
let result: boolean | void = undefined;

const mount = (extra: Partial<React.ComponentProps<typeof ChatComposer>> = {}) => act(async () => {
  root.render(
    <ChatComposer placeholder="p" cwd="/repo" onSubmit={(text, atts) => { submitted.push([text, atts]); return result; }}
      onQueue={(text, atts) => { queued.push([text, atts]); }} {...extra} />,
  );
});
const textarea = () => host.querySelector("textarea") as HTMLTextAreaElement;
const items = () => [...host.querySelectorAll("ul[aria-label='chat.attach.label'] > li")];
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });
const type = (value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(textarea(), value);
  textarea().dispatchEvent(new Event("input", { bubbles: true }));
});
function pasteEvent(files: File[], uriList = ""): Event {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.assign(e, { clipboardData: { files, getData: (type: string) => (type === "text/uri-list" ? uriList : "") } });
  return e;
}
const paste = async (files: File[], uriList = "") => {
  const e = pasteEvent(files, uriList);
  await act(async () => { textarea().dispatchEvent(e); });
  return e;
};
const png = () => new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
const key = (k: string, init: KeyboardEventInit = {}) => act(async () => { textarea().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  submitted = []; queued = []; result = undefined; mocks.picked = []; mocks.inspectFails = false; mocks.saved = 0;
  URL.createObjectURL = () => "blob:preview";
  URL.revokeObjectURL = () => undefined;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("colar no composer", () => {
  it("uma imagem do clipboard vira miniatura acima do texto (salva na pasta temporária) e a colagem não vai para a caixa", async () => {
    await mount();
    const e = await paste([png()]);
    expect(e.defaultPrevented).toBe(true);
    expect(items()).toHaveLength(1);
    const img = host.querySelector("ul[aria-label='chat.attach.label'] img") as HTMLImageElement;
    expect(img.src).toBe("blob:preview");
    expect(img.alt).toBe("chat.attach.pastedName.png");
    // a fileira vem antes da caixa de texto
    expect(host.querySelector("ul[aria-label='chat.attach.label']")!.compareDocumentPosition(textarea()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("texto comum colado segue o caminho normal (nada é interceptado)", async () => {
    await mount();
    const e = await paste([]);
    expect(e.defaultPrevented).toBe(false);
    expect(items()).toHaveLength(0);
  });

  it("um arquivo copiado no Finder (lista de URLs) vira anexo pelo caminho", async () => {
    await mount();
    await paste([], "file:///Users/ton/Docs/rel%C3%A1torio.pdf\r\nfile:///Users/ton/a%20b.png");
    expect(items()).toHaveLength(2);
    expect(host.textContent).toContain("relátorio.pdf");
    expect(host.querySelector("img[alt='a b.png']")).not.toBeNull();
  });

  it("arquivo colado sem caminho e que não é imagem: aviso explícito, nada se perde em silêncio", async () => {
    await mount();
    await type("meu texto");
    await paste([new File(["x"], "nota.txt", { type: "text/plain" })]);
    expect(items()).toHaveLength(0);
    expect(host.querySelector("[role=status]")!.textContent).toContain("chat.attach.notice.noPath");
    expect(textarea().value).toBe("meu texto");
  });
});

describe("soltar e o clipe usam a mesma regra", () => {
  it("o que o ouvinte nativo entrega ao composer à vista vira miniaturas, sem repetir o mesmo arquivo", async () => {
    await mount();
    expect(activeDropSink()).not.toBeNull();
    await act(async () => { activeDropSink()!.addPaths(["/p/a.png", "/p/a.png", "/p/b.pdf"]); });
    expect(items()).toHaveLength(2);
    await act(async () => { activeDropSink()!.addPaths(["/p/a.png"]); });
    expect(items()).toHaveLength(2);
  });

  it("o clipe: escolher arquivos põe miniaturas (não mais @menções no texto)", async () => {
    await mount();
    mocks.picked = ["/p/foto.png", "/p/doc.pdf"];
    await click(host.querySelector("[aria-label='chat.composer.attach']"));
    expect(items()).toHaveLength(2);
    expect(textarea().value).toBe("");
  });

  it("falha ao ler os anexos vira aviso e o texto digitado fica", async () => {
    await mount();
    await type("não perca isto");
    mocks.inspectFails = true;
    await act(async () => { activeDropSink()!.addPaths(["/p/a.png"]); });
    expect(host.querySelector("[role=status]")!.textContent).toContain("chat.attach.notice.inspect");
    expect(textarea().value).toBe("não perca isto");
  });

  it("acima do máximo, o excedente fica de fora com aviso e o resto entra", async () => {
    await mount();
    const paths = Array.from({ length: 12 }, (_, i) => `/p/f${i}.pdf`);
    await act(async () => { activeDropSink()!.addPaths(paths); });
    expect(items()).toHaveLength(10);
    expect(host.querySelector("[role=status]")!.textContent).toContain("chat.attach.notice.tooMany");
  });
});

describe("remover e enviar", () => {
  it("o × remove só aquele anexo", async () => {
    await mount();
    await act(async () => { activeDropSink()!.addPaths(["/p/a.png", "/p/b.pdf"]); });
    await click(host.querySelector("[aria-label='chat.attach.remove{\"name\":\"a.png\"}']"));
    expect(items()).toHaveLength(1);
    expect(host.textContent).toContain("b.pdf");
  });

  it("enviar só com anexos é permitido; o composer entrega o texto vazio e a lista, e limpa", async () => {
    await mount();
    await act(async () => { activeDropSink()!.addPaths(["/p/a.png"]); });
    await click(host.querySelector("button[type=submit]"));
    expect(submitted).toHaveLength(1);
    expect(submitted[0]![0]).toBe("");
    expect(submitted[0]![1].map((a) => a.path)).toEqual(["/p/a.png"]);
    expect(items()).toHaveLength(0);
  });

  it("sem texto nem anexo o enviar fica desligado", async () => {
    await mount();
    expect((host.querySelector("button[type=submit]") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { activeDropSink()!.addPaths(["/p/a.png"]); });
    expect((host.querySelector("button[type=submit]") as HTMLButtonElement).disabled).toBe(false);
  });

  it("se o envio falha (false), o texto e os anexos continuam para tentar de novo", async () => {
    result = false;
    await mount();
    await type("oi");
    await act(async () => { activeDropSink()!.addPaths(["/p/a.png"]); });
    await click(host.querySelector("button[type=submit]"));
    expect(items()).toHaveLength(1);
    expect(textarea().value).toBe("oi");
  });

  it("Enter envia, Shift+Enter não", async () => {
    await mount();
    await type("oi");
    await key("Enter", { shiftKey: true });
    expect(submitted).toHaveLength(0);
    await key("Enter");
    expect(submitted).toHaveLength(1);
  });

  it("⌘⏎ põe na fila COM os anexos (não os descarta)", async () => {
    await mount();
    await type("depois");
    await act(async () => { activeDropSink()!.addPaths(["/p/a.png"]); });
    await key("Enter", { metaKey: true });
    expect(queued).toHaveLength(1);
    expect(queued[0]![1].map((a) => a.path)).toEqual(["/p/a.png"]);
    expect(items()).toHaveLength(0);
  });

  it("com o agente trabalhando e só anexos, o botão não vira Parar", async () => {
    await mount({ onStop: () => undefined });
    expect(host.querySelector("[aria-label='chat.composer.stop']")).not.toBeNull();
    await act(async () => { activeDropSink()!.addPaths(["/p/a.png"]); });
    expect(host.querySelector("[aria-label='chat.composer.stop']")).toBeNull();
  });
});

describe("o bloco cresce", () => {
  it("o miolo (miniaturas + texto) rola por dentro com teto de 40% da janela; o enviar fica fora dele", async () => {
    await mount();
    const scroller = host.querySelector(".cc-scroll-hidden") as HTMLElement;
    expect(parseInt(scroller.style.maxHeight, 10)).toBe(Math.max(160, Math.floor(window.innerHeight * 0.4)));
    expect(scroller.contains(textarea())).toBe(true);
    expect(scroller.contains(host.querySelector("button[type=submit]"))).toBe(false);
  });
});
