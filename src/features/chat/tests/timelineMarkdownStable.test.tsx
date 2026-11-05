// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));

import { Markdown, type CodeBlock } from "@/shared/ui/Markdown";

// Uma função estável, como o `renderChatCodeBlock` do chat (do módulo, não criada a cada render).
const renderBlock = (block: CodeBlock) => <div data-code-block="">{block.pre}</div>;
const CONTENT = "Primeiro parágrafo com `código`.\n\n```bash\nnpm run build\n```\n\nSegundo parágrafo.";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const render = () => act(async () => {
  root.render(<Markdown content={CONTENT} tone="chat" renderCodeBlock={renderBlock} />);
});

describe("o markdown de uma fala não é remontado quando a conversa ganha mensagem", () => {
  it("renderizar de novo o mesmo texto mantém os mesmos nós do parágrafo e do bloco de código", async () => {
    await render();
    const paragraph = host.querySelector("p");
    const block = host.querySelector("pre");
    expect(paragraph).not.toBeNull();
    expect(block).not.toBeNull();

    await render();
    expect(host.querySelector("p")).toBe(paragraph);
    expect(host.querySelector("pre")).toBe(block);
  });
});
