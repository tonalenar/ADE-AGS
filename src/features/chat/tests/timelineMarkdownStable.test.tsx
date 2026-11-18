// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
vi.mock("../attachments/useImagePreview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../attachments/useImagePreview")>();
  return {
    ...actual,
    loadImage: (path: string) => Promise.resolve(`data:image/png;base64,${btoa(path)}`),
  };
});

import { Markdown, type CodeBlock } from "@/shared/ui/Markdown";
import { AttachCwdContext } from "../attachments/AttachmentStrip";
import { ChatMessageMarkdown } from "../attachments/ChatMessageMarkdown";
import { MediaViewerProvider } from "../attachments/MediaViewerContext";

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

  it("uma fala que cresce pedaço a pedaço (streaming) mantém os nós já desenhados", async () => {
    const draw = (content: string) => act(async () => {
      root.render(<ChatMessageMarkdown content={content} renderCodeBlock={renderBlock} streaming />);
    });
    await draw("Primeiro parágrafo");
    const paragraph = host.querySelector("p");
    expect(paragraph).not.toBeNull();

    await draw("Primeiro parágrafo com mais texto.\n\n```bash\nnpm run build\n```");
    const block = host.querySelector("pre");
    expect(host.querySelector("p")).toBe(paragraph);

    await draw("Primeiro parágrafo com mais texto.\n\n```bash\nnpm run build\n```\n\nSegundo");
    expect(host.querySelector("p")).toBe(paragraph);
    expect(host.querySelector("pre")).toBe(block);
  });

  it("streaming que ganha caminho de imagem mantém os nós já desenhados", async () => {
    const draw = (content: string) => act(async () => {
      root.render(
        <MediaViewerProvider target="tab-1" cwd="/p">
          <AttachCwdContext.Provider value="/p">
            <ChatMessageMarkdown content={content} renderCodeBlock={renderBlock} streaming />
          </AttachCwdContext.Provider>
        </MediaViewerProvider>,
      );
    });
    await draw("Primeiro parágrafo");
    expect(host.querySelector("p")).not.toBeNull();

    await draw("Primeiro parágrafo com mais texto.\n\n![a](/p/a.png)\n\n```bash\nnpm run build\n```\n\n`brand/x.png`");
    const paragraph = host.querySelector("p");
    const block = host.querySelector("pre");
    const image = host.querySelector("img");
    expect(paragraph).not.toBeNull();
    expect(block).not.toBeNull();
    expect(image).not.toBeNull();

    await draw("Primeiro parágrafo com mais texto.\n\n![a](/p/a.png)\n\n```bash\nnpm run build\n```\n\n`brand/x.png`\n\nSegundo");
    expect(host.querySelector("p")).toBe(paragraph);
    expect(host.querySelector("pre")).toBe(block);
    expect(host.querySelector("img")).toBe(image);
  });
});
