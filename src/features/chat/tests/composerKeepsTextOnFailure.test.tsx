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
  // Deixa o `submit` assíncrono terminar de aguardar o `onSubmit` antes de conferir o texto.
  await Promise.resolve();
  await Promise.resolve();
});

describe("o composer só limpa o texto depois de o envio ser aceito", () => {
  it("composer_mantem_texto_quando_envio_falha: o envio que não confirmou (sem `true`) deixa o texto na caixa", async () => {
    // Hoje a recusa do backend chega assim: o `onSubmit` termina sem devolver `true`.
    const onSubmit = vi.fn(() => Promise.resolve(undefined) as unknown as Promise<boolean>);
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
});
