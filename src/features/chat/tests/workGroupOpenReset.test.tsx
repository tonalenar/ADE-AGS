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
// Uma leitura com saída: a linha tem o que abrir (o conteúdo lido).
const leitura = (n: string): TimelineItem => ({ kind: "tool", id: `r-${n}`, tool: "read", path: `/r/${n}`, label: n, status: "done", output: `conteúdo de ${n}` });

let root: Root;
let host: HTMLDivElement;
const draw = (items: TimelineItem[]) => act(async () => {
  root.render(<TimelineView items={items} loaded working approval={null} agentLabel="Claude" agentId="claude-code" live />);
});
// A linha de uma leitura só (o botão começa com o verbo, sem resumo).
const linhaUnica = () => [...host.querySelectorAll("button")].find((b) => /^Leu[a-z]/.test(b.textContent ?? "")) ?? null;
// O resumo de duas ou mais leituras.
const resumo = () => [...host.querySelectorAll("button")].find((b) => /^Leu 2 arquivos/.test(b.textContent ?? "")) ?? null;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); vi.restoreAllMocks(); });

describe("a linha de uma ferramenta e o resumo não herdam o aberto um do outro", () => {
  it("1_para_N_comeca_recolhido: a linha aberta vira resumo recolhido quando chega a segunda ferramenta", async () => {
    await draw([user, leitura("a.ts")]);
    await act(async () => { linhaUnica()!.click(); });
    expect(linhaUnica()!.getAttribute("aria-expanded")).toBe("true");

    await draw([user, leitura("a.ts"), leitura("b.ts")]);
    expect(resumo()).not.toBeNull();
    expect(resumo()!.getAttribute("aria-expanded")).toBe("false");
  });

  it("N_para_1_comeca_recolhido: o resumo aberto volta a uma ferramenta só e a linha começa recolhida", async () => {
    await draw([user, leitura("a.ts"), leitura("b.ts")]);
    await act(async () => { resumo()!.click(); });
    expect(resumo()!.getAttribute("aria-expanded")).toBe("true");

    await draw([user, leitura("a.ts")]);
    expect(linhaUnica()!.getAttribute("aria-expanded")).toBe("false");
  });
});
