/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const t = vi.hoisted(() => (key: string) => key);
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }) }));

import { ArtboardFrame, type FrameHandlers, type StudioBoard } from "../ArtboardFrame";

const handlers: FrameHandlers = {
  onTitleDown: vi.fn(), onGripDown: vi.fn(), onRenameStart: vi.fn(), onRename: vi.fn(), onContext: vi.fn(),
  onExpand: vi.fn(), onPlay: vi.fn(), onFrameLoad: vi.fn(), onForceLoad: vi.fn(), register: vi.fn(),
};

const page = (head: string, body: string) => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const RED_HEAD = "<style>p{color:red}</style>";
const BLUE_HEAD = "<style>p{color:blue}</style>";

const board = (html: string): StudioBoard => ({ id: "b1", title: "Prancheta", x: 0, y: 0, w: 320, h: 200, html, radius: 0, version: 1 });

let host: HTMLDivElement;
let root: Root;

function render(html: string) {
  return act(async () => {
    root.render(
      <ArtboardFrame board={board(html)} live selected={false} grips={false} passThrough={false} agent={null}
        renaming={false} playing={false} guides={false} h={handlers} />,
    );
  });
}

function srcdocOf(): string {
  return host.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("ArtboardFrame: troca de HTML", () => {
  it("mudança só no corpo: o iframe não recarrega o documento", async () => {
    await render(page(RED_HEAD, "<p>um</p>"));
    const before = srcdocOf();
    await render(page(RED_HEAD, "<p>dois</p>"));
    expect(srcdocOf()).toBe(before);
  });

  it("mudança no head (estilo): o srcdoc passa a ter o estilo novo", async () => {
    await render(page(RED_HEAD, "<p>um</p>"));
    expect(srcdocOf()).toContain("color:red");
    await render(page(BLUE_HEAD, "<p>um</p>"));
    expect(srcdocOf()).toContain("color:blue");
    expect(srcdocOf()).not.toContain("color:red");
  });
});
