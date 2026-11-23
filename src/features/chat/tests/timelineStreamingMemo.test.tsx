// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18next from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import pt from "@/i18n/locales/pt-BR.json";

const i18n = i18next.createInstance();
await i18n.init({ lng: "pt-BR", resources: { "pt-BR": { translation: pt } }, interpolation: { escapeValue: false } });

const counters = vi.hoisted(() => ({
  markdownParses: 0,
  parsedTexts: [] as string[],
  personBubbleRenders: [] as string[],
  agentBubbleRenders: [] as string[],
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => i18n.t(key, o), i18n }) }));
vi.mock("../LiveActivity", () => ({ PlanCard: () => null }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  const RealMarkdown = actual.default;
  return {
    ...actual,
    default: function CountingReactMarkdown(props: React.ComponentProps<typeof RealMarkdown>) {
      counters.markdownParses++;
      counters.parsedTexts.push(String(props.children ?? ""));
      return <RealMarkdown {...props} />;
    },
  };
});
vi.mock("../timeline/Bubbles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../timeline/Bubbles")>();
  return {
    ...actual,
    PersonBubble: function CountingPersonBubble(props: React.ComponentProps<typeof actual.PersonBubble>) {
      counters.personBubbleRenders.push(props.itemId ?? "?");
      return <actual.PersonBubble {...props} />;
    },
    AgentBubble: function CountingAgentBubble(props: React.ComponentProps<typeof actual.AgentBubble>) {
      counters.agentBubbleRenders.push(props.itemId ?? "?");
      return <actual.AgentBubble {...props} />;
    },
  };
});

import { Markdown, type CodeBlock } from "@/shared/ui/Markdown";
import { ChatMessageMarkdown } from "../attachments/ChatMessageMarkdown";
import { DEFAULT_CHAT_PREFS, saveChatPrefs } from "../chatPrefs";
import { TimelineView } from "../timeline/ConversationTimeline";
import { withDrafts } from "../timeline/streaming";
import type { TimelineItem } from "../timeline/types";

const renderBlock = (block: CodeBlock) => <div data-code-block="">{block.pre}</div>;

function buildClosedTurns(count: number): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (let i = 0; i < count; i++) {
    items.push({ kind: "user", id: `u-${i}`, text: `Pergunta ${i}`, at: 1000 + i * 100 });
    items.push({ kind: "assistant", id: `a-${i}`, text: `Resposta **${i}** com \`código\`.`, at: 1050 + i * 100 });
    items.push({ kind: "turnEnd", id: `e-${i}`, durationMs: 50, at: 1080 + i * 100 });
  }
  return items;
}

let root: Root;
let host: HTMLDivElement;

function resetCounters(): void {
  counters.markdownParses = 0;
  counters.parsedTexts.length = 0;
  counters.personBubbleRenders.length = 0;
  counters.agentBubbleRenders.length = 0;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  saveChatPrefs({ ...DEFAULT_CHAT_PREFS, toolCallVisibility: "showAll" });
  resetCounters();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("memoização de Markdown e turnos durante o streaming (F-R1)", () => {
  it("Markdown e ChatMessageMarkdown não reprocessam quando as props permanecem iguais", async () => {
    const draw = (content: string, streaming = false) => act(async () => {
      root.render(
        <div>
          <Markdown content={content} tone="chat" renderCodeBlock={renderBlock} streaming={streaming} />
          <ChatMessageMarkdown content={content} tone="chat" renderCodeBlock={renderBlock} streaming={streaming} />
        </div>,
      );
    });

    await draw("Texto **estável**.");
    expect(counters.markdownParses).toBe(2);

    resetCounters();
    await draw("Texto **estável**.");
    expect(counters.markdownParses).toBe(0);

    // Quando o conteúdo muda de verdade, deve reprocessar normalmente.
    await draw("Texto **atualizado**.");
    expect(counters.markdownParses).toBe(2);
    expect(host.textContent).toContain("atualizado");
  });

  it("delta de streaming reprocessa só o turno aberto e não os turnos anteriores", async () => {
    const history = buildClosedTurns(10);
    const openUser: TimelineItem = { kind: "user", id: "u-live", text: "Explique passo a passo", at: 5000 };
    const baseItems = [...history, openUser];

    const drawDelta = (draftText: string) => act(async () => {
      const drafts = [{ itemId: "a-live", kind: "assistant" as const, text: draftText }];
      const items = withDrafts(baseItems, drafts);
      // Novo Set a cada quadro, como StructuredConversationView faz.
      const streaming = new Set(drafts.map((d) => d.itemId));
      root.render(
        <TimelineView
          items={items}
          loaded
          working
          approval={null}
          streaming={streaming}
          agentLabel="Claude"
          agentId="claude-code"
          live
        />,
      );
    });

    await drawDelta("Início");
    expect(counters.markdownParses).toBe(11);

    // 5 quadros de streaming no turno aberto: nenhum turno anterior pode re-renderizar ou re-parsear Markdown.
    resetCounters();
    for (let step = 1; step <= 5; step++) {
      await drawDelta(`Início — pedaço ${step}`);
    }

    expect(counters.markdownParses).toBe(5);
    expect(counters.parsedTexts).toEqual([
      "Início — pedaço 1",
      "Início — pedaço 2",
      "Início — pedaço 3",
      "Início — pedaço 4",
      "Início — pedaço 5",
    ]);
    // Nenhum turno fechado (u-0..u-9 / a-0..a-9) deve ter re-renderizado.
    expect(counters.personBubbleRenders.filter((id) => id !== "u-live")).toEqual([]);
    expect(counters.agentBubbleRenders).toEqual(["a-live", "a-live", "a-live", "a-live", "a-live"]);
    expect(host.textContent).toContain("Início — pedaço 5");
  });

  it("turnos fechados continuam memoizados com toolCallVisibility diferente de showAll", async () => {
    saveChatPrefs({ ...DEFAULT_CHAT_PREFS, toolCallVisibility: "hideSuccessful" });
    const history = buildClosedTurns(8);
    const openUser: TimelineItem = { kind: "user", id: "u-live", text: "Continue", at: 5000 };
    const baseItems = [...history, openUser];

    const drawDelta = (draftText: string) => act(async () => {
      const drafts = [{ itemId: "a-live", kind: "assistant" as const, text: draftText }];
      const items = withDrafts(baseItems, drafts);
      const streaming = new Set(drafts.map((d) => d.itemId));
      root.render(
        <TimelineView
          items={items}
          loaded
          working
          approval={null}
          streaming={streaming}
          agentLabel="Claude"
          agentId="claude-code"
          live
        />,
      );
    });

    await drawDelta("Bloco 0");
    resetCounters();
    await drawDelta("Bloco 0 e 1");
    await drawDelta("Bloco 0 e 1 e 2");

    expect(counters.markdownParses).toBe(2);
    expect(counters.personBubbleRenders.filter((id) => id !== "u-live")).toEqual([]);
  });

  it("fala anterior já concluída dentro do mesmo turno aberto não re-parseia durante streaming da fala atual", async () => {
    const openUser: TimelineItem = { kind: "user", id: "u-live", text: "Rode dois passos", at: 5000 };
    const firstAssistant: TimelineItem = { kind: "assistant", id: "a-prev", text: "Primeiro passo concluído.", at: 5010 };
    const toolDone: TimelineItem = { kind: "tool", id: "t-1", tool: "read", path: "/p/a.ts", status: "done", at: 5020 };
    const baseItems = [openUser, firstAssistant, toolDone];

    const drawDelta = (draftText: string) => act(async () => {
      const drafts = [{ itemId: "a-curr", kind: "assistant" as const, text: draftText }];
      const items = withDrafts(baseItems, drafts);
      const streaming = new Set(drafts.map((d) => d.itemId));
      root.render(
        <TimelineView
          items={items}
          loaded
          working
          approval={null}
          streaming={streaming}
          agentLabel="Claude"
          agentId="claude-code"
          live
        />,
      );
    });

    await drawDelta("Segundo passo");
    resetCounters();
    await drawDelta("Segundo passo em andamento");
    await drawDelta("Segundo passo quase pronto");

    expect(counters.markdownParses).toBe(2);
    expect(counters.agentBubbleRenders).toEqual(["a-curr", "a-curr"]);
  });
});
