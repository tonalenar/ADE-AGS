// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));
vi.mock("@/features/recording/VoiceInputButton", () => ({
  VoiceInputButton: ({ onTranscript }: { onTranscript: (text: string) => void }) => (
    <button type="button" data-testid="voz" onClick={() => onTranscript("adicionando voz com segurança")}>voz</button>
  ),
}));

import { ChatComposer, insertAtCaret } from "../ChatComposer";

class FakeObserver {
  constructor(private cb: () => void) {}
  observe() { this.cb(); }
  disconnect() { /* nada */ }
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: FakeObserver });
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); vi.restoreAllMocks(); });

describe("insertAtCaret", () => {
  it("insere no cursor com espaço e ignora transcrição vazia", () => {
    expect(insertAtCaret("Mensagem inicial", 16, 16, "adicionando voz com segurança"))
      .toEqual({ text: "Mensagem inicial adicionando voz com segurança", caret: 46 });
    expect(insertAtCaret("abc", 1, 2, "  ")).toBeNull();
  });
});

describe("transcrição de voz no composer", () => {
  it("insere o texto transcrito na posição do cursor sem enviar", async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(<ChatComposer placeholder="p" onSubmit={onSubmit} />);
    });
    const box = host.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(box, "Mensagem inicial");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    box.setSelectionRange(16, 16);
    await act(async () => { (host.querySelector("[data-testid=voz]") as HTMLButtonElement).click(); });
    expect(box.value).toBe("Mensagem inicial adicionando voz com segurança");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
