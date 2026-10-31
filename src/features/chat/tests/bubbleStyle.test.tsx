// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));

import { AgentBubble, PersonBubble } from "../timeline/Bubbles";

let root: Root;
let host: HTMLDivElement;
const render = (node: React.ReactNode) => act(async () => { root.render(node); });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("balão só do usuário", () => {
  it("a mensagem da pessoa tem balão: fundo, cantos arredondados, à direita e com largura máxima", async () => {
    await render(<PersonBubble text="oi" />);
    const bubble = host.querySelector(".rounded-2xl") as HTMLElement;
    expect(bubble.className).toMatch(/bg-gray-200/);
    expect(bubble.className).toContain("max-w-[85%]");
    expect(host.firstElementChild!.className).toContain("items-end");
  });

  it("a fala do agente NÃO tem balão (sem fundo, borda nem cantos arredondados) mas leva o logo e o nome", async () => {
    await render(<AgentBubble agentId="claude-code" label="Claude Code" header><p>resposta</p></AgentBubble>);
    const html = host.innerHTML;
    expect(html).not.toMatch(/\bbg-/);
    expect(html).not.toMatch(/rounded-/);
    expect(html).not.toMatch(/\bborder\b/);
    expect(host.querySelector("[role=img][aria-label='Claude Code']")).not.toBeNull();
    expect(host.textContent).toContain("Claude Code");
  });

  it("sem header (mesma voz seguida) só o texto, sem repetir o nome", async () => {
    await render(<AgentBubble agentId="claude-code" label="Claude Code"><p>mais uma</p></AgentBubble>);
    expect(host.querySelector("[role=img]")).toBeNull();
    expect(host.textContent).toBe("mais uma");
  });

  it("a fala de um colega (peer) leva o nome de quem mandou, também sem balão", async () => {
    await render(<AgentBubble agentId="" label="Codex" sender="Codex · Backend" header><p>pronto</p></AgentBubble>);
    expect(host.textContent).toContain("Codex · Backend");
    expect(host.innerHTML).not.toMatch(/\bbg-/);
  });
});
