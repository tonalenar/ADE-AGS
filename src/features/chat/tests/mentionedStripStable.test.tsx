// @vitest-environment happy-dom
import { Profiler, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]), convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve(), openPath: () => Promise.resolve(), revealItemInDir: () => Promise.resolve() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));

import { AttachCwdContext } from "../attachments/AttachmentStrip";
import { ChatMessageMarkdown } from "../attachments/ChatMessageMarkdown";
import { MediaViewerProvider } from "../attachments/MediaViewerContext";

let root: Root;
let host: HTMLDivElement;
let commits: number;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  commits = 0;
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const draw = (content: string) => act(async () => {
  root.render(
    <Profiler id="visualizador" onRender={() => { commits += 1; }}>
      <MediaViewerProvider target="tab-1" cwd="/p">
        <AttachCwdContext.Provider value="/p">
          <ChatMessageMarkdown content={content} streaming />
        </AttachCwdContext.Provider>
      </MediaViewerProvider>
    </Profiler>,
  );
});

describe("a fileira de imagens citadas não refaz o registro no visualizador a cada pedaço do texto", () => {
  it("um texto que cresce com a mesma imagem citada registra uma vez só, não uma por pedaço", async () => {
    await draw("Veja a gravação em `videos/demo.mp4`.");
    commits = 0;
    await draw("Veja a gravação em `videos/demo.mp4`. Ela mostra");
    await draw("Veja a gravação em `videos/demo.mp4`. Ela mostra o build");
    await draw("Veja a gravação em `videos/demo.mp4`. Ela mostra o build pronto.");
    // Um commit por pedaço (o texto muda); nenhum a mais por um registro que não muda nada.
    expect(commits).toBe(3);
  });
});
