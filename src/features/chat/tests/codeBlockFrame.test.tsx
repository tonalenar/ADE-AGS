// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));

import { Markdown } from "@/shared/ui/Markdown";

import { renderChatCodeBlock, RunCodeContext } from "../timeline/CodeBlockFrame";

let root: Root;
let host: HTMLDivElement;
const button = (name: string) => host.querySelector(`[aria-label="${name}"]`) as HTMLButtonElement | null;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const render = (content: string, run: ((c: string) => void) | null) => act(async () => {
  root.render(<RunCodeContext.Provider value={run}><Markdown content={content} tone="chat" renderCodeBlock={renderChatCodeBlock} /></RunCodeContext.Provider>);
});

describe("o bloco de código do chat (Rodar e Copiar)", () => {
  it("bloco de shell ganha Rodar, que manda o comando ao terminal da conversa só no clique", async () => {
    const run = vi.fn();
    await render("Para conferir, rode:\n\n```bash\nsecurity find-identity -p codesigning\n```\n", run);
    expect(run).not.toHaveBeenCalled();
    await act(async () => { button("chat.code.run")!.click(); });
    expect(run).toHaveBeenCalledWith("security find-identity -p codesigning");
    expect(button("chat.code.copy")).not.toBeNull();
  });

  it("Copiar leva o código sem o fim de linha", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await render("```ts\nconst a = 1;\n```", null);
    await act(async () => { button("chat.code.copy")!.click(); });
    expect(writeText).toHaveBeenCalledWith("const a = 1;");
  });

  it("bloco que não é de shell, ou sem terminal para onde mandar, só copia", async () => {
    await render("```ts\nconst a = 1;\n```", vi.fn());
    expect(button("chat.code.run")).toBeNull();
    await render("```bash\nls\n```", null);
    expect(button("chat.code.run")).toBeNull();
    expect(button("chat.code.copy")).not.toBeNull();
  });

  it("código em linha não vira bloco", async () => {
    await render("rode `ls` aqui", vi.fn());
    expect(host.querySelector("[data-code-block]")).toBeNull();
  });
});
