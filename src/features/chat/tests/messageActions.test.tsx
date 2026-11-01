// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key}${JSON.stringify(o)}` : key), i18n: { language: "pt-BR" } }),
}));

import { useChatStore } from "../store";
import { AgentBubble, PersonBubble } from "../timeline/Bubbles";
import { relativeTime } from "../timeline/messageTime";
import { withAttachmentBlock } from "../attachments/attachModel";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

describe("a hora relativa sob a mensagem", () => {
  it("diz há quanto tempo, na língua da pessoa", () => {
    expect(relativeTime(NOW - 30_000, NOW, "pt-BR")).toBe("agora");
    expect(relativeTime(NOW - 24 * MIN, NOW, "pt-BR")).toBe("há 24 minutos");
    expect(relativeTime(NOW - 3 * 60 * MIN, NOW, "pt-BR")).toBe("há 3 horas");
    expect(relativeTime(NOW - 2 * 24 * 60 * MIN, NOW, "pt-BR")).toBe("anteontem");
    expect(relativeTime(NOW - 24 * MIN, NOW, "en")).toBe("24 minutes ago");
  });

  it("sem carimbo, ou com um relógio atrasado, não inventa nada", () => {
    expect(relativeTime(undefined, NOW, "pt-BR")).toBeNull();
    expect(relativeTime(NOW + 5 * MIN, NOW, "pt-BR")).toBe("agora");
  });
});

describe("as ações ao passar o mouse nas mensagens", () => {
  let root: Root;
  let host: HTMLDivElement;
  let written: string[] = [];
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    written = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } } });
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    useChatStore.setState({ composerInsert: null });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); vi.restoreAllMocks(); });
  const click = (label: string) => act(async () => { (host.querySelector(`[aria-label='${label}']`) as HTMLElement).click(); });

  it("a mensagem da pessoa: copiar e editar, com a hora; só aparecem ao passar o mouse ou focar (sem hover fixo)", async () => {
    await act(async () => { root.render(<PersonBubble text="sim, pode gerar a build" at={NOW - 24 * MIN} />); });
    const row = host.querySelector("[data-message-actions]") as HTMLElement;
    expect(row.className).toContain("opacity-0");
    expect(row.className).toContain("group-hover:opacity-100");
    expect(row.className).toContain("group-focus-within:opacity-100");
    expect(row.textContent).toContain("há 24 minutos");
    expect(host.querySelector("[aria-label='chat.message.copy']")).not.toBeNull();
    expect(host.querySelector("[aria-label='chat.message.edit']")).not.toBeNull();
  });

  it("copiar leva o texto LIMPO da pessoa: sem o bloco de anexos", async () => {
    const text = withAttachmentBlock("veja isto", [
      { id: "/a/x.png", path: "/a/x.png", name: "x.png", kind: "image", mime: null, size: 1, preview: null, temp: false },
    ]);
    await act(async () => { root.render(<PersonBubble text={text} at={NOW - MIN} />); });
    await click("chat.message.copy");
    expect(written).toEqual(["veja isto"]);
  });

  it("editar devolve o texto ao campo de mensagem (não cancela nada)", async () => {
    await act(async () => { root.render(<PersonBubble text="refazer isto" at={NOW - MIN} />); });
    await click("chat.message.edit");
    expect(useChatStore.getState().composerInsert?.text).toBe("refazer isto");
  });

  it("a resposta do agente: copiar o texto e a hora, sem o botão de editar", async () => {
    await act(async () => { root.render(<AgentBubble agentId="claude-code" label="Claude Code" at={NOW - 29 * MIN} copyText="**Resposta** pronta"><p>x</p></AgentBubble>); });
    expect(host.textContent).toContain("há 29 minutos");
    expect(host.querySelector("[aria-label='chat.message.edit']")).toBeNull();
    await click("chat.message.copy");
    expect(written).toEqual(["**Resposta** pronta"]);
  });

  it("mensagem ainda sem carimbo (enviando) ou sem texto para copiar não mostra ações", async () => {
    await act(async () => { root.render(<PersonBubble text="enviando" sending />); });
    expect(host.querySelector("[data-message-actions]")).toBeNull();
    await act(async () => { root.render(<AgentBubble agentId="claude-code" label="Claude Code"><p>x</p></AgentBubble>); });
    expect(host.querySelector("[data-message-actions]")).toBeNull();
  });
});
