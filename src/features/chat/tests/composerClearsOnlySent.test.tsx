// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ picked: [] as string[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(mocks.picked) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: () => Promise.resolve() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("../attachments/ipc", () => ({
  inspectPaths: (paths: string[]) => Promise.resolve(paths.map((p) => ({ path: p, name: p.split("/").pop()!, kind: "file", mime: null, size: 1000, error: null }))),
  readImage: () => Promise.resolve({ mime: "image/png", dataUrl: "data:image/png;base64,AAAA" }),
}));

import { ChatComposer } from "../ChatComposer";
import { addQuoteFor, useQuoteStore } from "../quotes/quoteStore";

const KEY = "conv-1";
let root: Root;
let host: HTMLDivElement;
let accept: (value: boolean) => void = () => undefined;

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const textarea = () => host.querySelector("textarea[data-chat-composer]") as HTMLTextAreaElement;
const typeText = (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea(), value);
  textarea().dispatchEvent(new Event("input", { bubbles: true }));
});
const attachFile = async (path: string) => {
  mocks.picked = [path];
  await act(async () => { host.querySelector<HTMLButtonElement>("[aria-label='chat.composer.attach']")!.click(); });
  await flush();
};
const enter = () => act(async () => {
  textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
});
const attachmentNames = () => [...host.querySelectorAll("ul[aria-label='chat.attach.label'] > li")].map((li) => li.textContent ?? "");
const citations = () => useQuoteStore.getState().byKey[KEY] ?? [];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() { /* nada */ } disconnect() { /* nada */ } } });
  useQuoteStore.setState({ byKey: {}, openEditByKey: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

async function mountWithPendingSend() {
  // O envio fica pendente até o teste liberar a resposta do backend.
  const onSubmit = vi.fn(() => new Promise<boolean>((resolve) => { accept = resolve; }));
  await act(async () => { root.render(<ChatComposer placeholder="p" cwd="/repo" quoteKey={KEY} onSubmit={onSubmit} />); });
  return onSubmit;
}

describe("a caixa limpa por campo, só o que foi enviado", () => {
  it("digitou_no_meio_anexo_e_citacao_enviados_saem: o texto novo fica; o anexo e a citação enviados saem", async () => {
    addQuoteFor(KEY, { text: "trecho citado" });
    await mountWithPendingSend();
    await typeText("mensagem enviada");
    await attachFile("/p/enviado.pdf");
    await enter();
    await typeText("mensagem enviada e uma segunda frase");
    await act(async () => { accept(true); });
    await flush();
    expect(textarea().value).toBe("mensagem enviada e uma segunda frase");
    expect(attachmentNames()).toEqual([]);
    expect(citations()).toEqual([]);
  });

  it("anexou_no_meio_texto_enviado_sai_e_o_anexo_novo_fica: o texto enviado sai da caixa; o anexo adicionado fica", async () => {
    await mountWithPendingSend();
    await typeText("mensagem enviada");
    await attachFile("/p/enviado.pdf");
    await enter();
    await attachFile("/p/novo.pdf");
    await act(async () => { accept(true); });
    await flush();
    expect(textarea().value).toBe("");
    expect(attachmentNames()).toHaveLength(1);
    expect(attachmentNames()[0]).toContain("novo.pdf");
  });
});
