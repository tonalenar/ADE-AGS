// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));

import { ChatComposer } from "../ChatComposer";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const textarea = () => host.querySelector("textarea[data-chat-composer]") as HTMLTextAreaElement;
const digitar = (valor: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea(), valor);
  textarea().dispatchEvent(new Event("input", { bubbles: true }));
});
const enviarComEnter = () => act(async () => {
  textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
});

describe("o composer só limpa o texto depois de o envio ser aceito", () => {
  it("composer_mantem_texto_quando_envio_falha: o envio recusado (false) deixa o texto na caixa", async () => {
    // A recusa do backend: o `onSubmit` resolve `false`.
    const onSubmit = vi.fn(() => Promise.resolve(false));
    await act(async () => { root.render(<ChatComposer placeholder="p" onSubmit={onSubmit} />); });
    await digitar("minha mensagem");
    await enviarComEnter();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe("minha mensagem");
  });

  it("o texto só sai da caixa quando o envio é aceito (true)", async () => {
    const onSubmit = vi.fn(() => Promise.resolve(true));
    await act(async () => { root.render(<ChatComposer placeholder="p" onSubmit={onSubmit} />); });
    await digitar("minha mensagem");
    await enviarComEnter();
    expect(textarea().value).toBe("");
  });

  it("texto_digitado_durante_o_envio_nao_e_apagado: o que a pessoa digitou enquanto o IPC ia é mantido, mesmo com o envio aceito", async () => {
    let accept: (value: boolean) => void = () => undefined;
    const onSubmit = vi.fn(() => new Promise<boolean>((resolve) => { accept = resolve; }));
    await act(async () => { root.render(<ChatComposer placeholder="p" onSubmit={onSubmit} />); });
    await digitar("primeira");
    await enviarComEnter();
    // Enquanto o backend não responde, a pessoa escreve mais na mesma caixa.
    await digitar("primeira e uma segunda");
    await act(async () => { accept(true); });
    expect(textarea().value).toBe("primeira e uma segunda");
  });
});
