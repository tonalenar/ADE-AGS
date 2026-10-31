// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));

import { TimelineView } from "../timeline/ConversationTimeline";
import type { TimelineItem } from "../timeline/types";

const OPTIONS = ["Autorizo ade-jev (Recommended)", "Eu faço no lugar dele"];
const ask = (id: string, status: "running" | "done" = "running"): TimelineItem => ({
  kind: "tool", id, tool: "question", status, label: "pergunta", question: { text: "Autoriza o ade-jev em team/backend-jev?", options: OPTIONS },
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const mount = (items: TimelineItem[], onAnswer?: (choice: string) => void) => act(async () => {
  root.render(<TimelineView items={items} loaded working approval={null} agentLabel="Claude Code" agentId="claude-code" onAnswer={onAnswer} />);
});
const option = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

describe("as opções da pergunta do agente respondem ao clique", () => {
  it("cada opção é um botão e clicar manda a escolha como resposta", async () => {
    const answers: string[] = [];
    await mount([{ kind: "user", id: "u", text: "monte o time" }, ask("q1")], (c) => answers.push(c));
    expect(host.textContent).toContain("chat.timeline.question");
    expect(option(OPTIONS[0]!)).toBeDefined();
    await act(async () => { option(OPTIONS[1]!)!.click(); });
    await act(async () => { option(OPTIONS[0]!)!.click(); });
    expect(answers).toEqual([OPTIONS[1], OPTIONS[0]]);
  });

  it("os botões são alcançáveis pelo teclado (botões de verdade, com foco visível)", async () => {
    await mount([{ kind: "user", id: "u", text: "x" }, ask("q1")], () => undefined);
    const b = option(OPTIONS[0]!)!;
    expect(b.tagName).toBe("BUTTON");
    expect(b.type).toBe("button");
    expect(b.className).toContain("focus-visible:ring");
  });

  it("sem uma pergunta esperando (já respondida, ou conversa sem resposta pelo chat) as opções ficam só como registro", async () => {
    await mount([{ kind: "user", id: "u", text: "x" }, ask("q1")]);
    expect(option(OPTIONS[0]!)).toBeUndefined();
    expect(host.textContent).toContain(OPTIONS[0]);
  });

  it("uma pergunta antiga (já houve resposta e o turno seguiu) não responde ao clique", async () => {
    const answers: string[] = [];
    const items: TimelineItem[] = [
      { kind: "user", id: "u", text: "x" },
      ask("q1", "done"),
      { kind: "assistant", id: "a", text: "ok, seguindo" },
    ];
    await mount(items, (c) => answers.push(c));
    expect(option(OPTIONS[0]!)).toBeUndefined();
    expect(answers).toEqual([]);
  });

  it("listas em texto do próprio agente NÃO viram botões (só o cartão estruturado responde)", async () => {
    const list: TimelineItem = { kind: "assistant", id: "a", text: "Opções:\n• Autorizo ade-jev em team/backend-jev\n• Manter apenas team/backend" };
    await mount([{ kind: "user", id: "u", text: "x" }, list], () => undefined);
    expect([...host.querySelectorAll("button")].some((b) => /Autorizo ade-jev em/.test(b.textContent ?? ""))).toBe(false);
  });
});
