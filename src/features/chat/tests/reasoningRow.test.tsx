// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));

import { TimelineView } from "../timeline/ConversationTimeline";
import type { TimelineItem } from "../timeline/types";

const THOUGHT = "Vou deixar o controle de desligar mais fácil de achar.";
const asking: TimelineItem = { kind: "user", id: "u1", text: "melhore o botão" };
const thought: TimelineItem = { kind: "reasoning", id: "r1", text: THOUGHT };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const mount = (items: TimelineItem[], working: boolean, approval: { title: string } | null = null) => act(async () => {
  root.render(<TimelineView items={items} loaded working={working} approval={approval} live agentLabel="Claude Code" agentId="claude-code" />);
});

describe("o raciocínio do agente aparece na conversa", () => {
  it("mostra o resumo do pensamento, em cinza, numa linha com o rótulo traduzido", async () => {
    await mount([asking, thought], true);
    const row = host.querySelector("[data-reasoning]") as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain(THOUGHT);
    expect(row.getAttribute("aria-label")).toBe("chat.timeline.reasoning");
  });

  it("enquanto o modelo ainda pensa, mostra «Pensando…» com o brilho (e só nele)", async () => {
    await mount([asking, thought], true);
    const live = host.querySelector("[data-thinking]") as HTMLElement;
    expect(live.textContent).toContain("chat.live.thinking");
    expect(live.querySelector(".cc-shimmer")).not.toBeNull();
    expect(host.querySelectorAll(".cc-shimmer")).toHaveLength(1);
  });

  it("sem o turno rodando, ou com um pedido de aprovação esperando, não há «Pensando…», mas o resumo continua", async () => {
    await mount([asking, thought], false);
    expect(host.querySelector("[data-thinking]")).toBeNull();
    expect(host.textContent).toContain(THOUGHT);
    await mount([asking, thought], true, { title: "Rodar npm test" });
    expect(host.querySelector("[data-thinking]")).toBeNull();
  });

  it("quando o agente passa a agir (ferramenta), o «Pensando…» sai", async () => {
    await mount([asking, thought, { kind: "tool", id: "t1", tool: "read", status: "running", label: "a.ts" }], true);
    expect(host.querySelector("[data-thinking]")).toBeNull();
  });

  it("um resumo longo abre e fecha ao clicar", async () => {
    await mount([asking, { ...thought, text: `${THOUGHT}\n\nSegundo parágrafo do raciocínio.` }], false);
    const button = host.querySelector("[data-reasoning] button") as HTMLButtonElement;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { button.click(); });
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });
});
