// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18next from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import pt from "@/i18n/locales/pt-BR.json";

const i18n = i18next.createInstance();
await i18n.init({ lng: "pt-BR", resources: { "pt-BR": { translation: pt } }, interpolation: { escapeValue: false } });

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => i18n.t(key, o), i18n }) }));
vi.mock("@/shared/ui/LazyMarkdown", () => ({ Markdown: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock("../LiveActivity", () => ({ PlanCard: () => null }));

import { TimelineView } from "../timeline/ConversationTimeline";
import type { TimelineItem } from "../timeline/types";

const user: TimelineItem = { kind: "user", id: "u", text: "faça" };
const leitura = (n: string): TimelineItem => ({ kind: "tool", id: `r-${n}`, tool: "read", path: `/r/${n}`, label: n, status: "done" });

let root: Root;
let host: HTMLDivElement;
const draw = (items: TimelineItem[]) => act(async () => {
  root.render(<TimelineView items={items} loaded working approval={null} agentLabel="Claude" agentId="claude-code" live />);
});
// A linha da primeira leitura: o botão cujo texto começa com o verbo (antes ou depois de virar resumo).
const linhaDeLeitura = () => [...host.querySelectorAll("button")].find((b) => /^Leu/.test(b.textContent ?? "")) ?? null;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("a linha de uma ferramenta vira o resumo sem trocar de componente", () => {
  it("segunda_ferramenta_nao_remonta_a_primeira: a linha de leitura é o mesmo nó quando chega a segunda", async () => {
    await draw([user, leitura("a.ts")]);
    const primeira = linhaDeLeitura();
    expect(primeira).not.toBeNull();
    expect(primeira!.textContent).toContain("a.ts");

    await draw([user, leitura("a.ts"), leitura("b.ts")]);
    expect(host.textContent).toContain("Leu 2 arquivos");
    expect(linhaDeLeitura()).toBe(primeira);
  });
});
