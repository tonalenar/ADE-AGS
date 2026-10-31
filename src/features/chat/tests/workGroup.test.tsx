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
const cmd = (n: number, extra: Partial<TimelineItem> = {}): TimelineItem => ({ kind: "tool", id: `c${n}`, tool: "command", label: `/bin/zsh -lc "git log -n ${n} --oneline"`, status: "done", ...extra });
const read = (extra: Partial<TimelineItem> = {}): TimelineItem => ({ kind: "tool", id: "r", tool: "read", path: "/r/accountConnect.ts", label: "accountConnect.ts", status: "error", ...extra });
const end: TimelineItem = { kind: "turnEnd", id: "e", durationMs: 4000 };

let root: Root;
let host: HTMLDivElement;
const render = (items: TimelineItem[], working = true) => act(async () => {
  root.render(<TimelineView items={items} loaded working={working} approval={null} agentLabel="Claude" agentId="claude-code" live />);
});
const groupButton = () => [...host.querySelectorAll("button[aria-expanded]")].find((b) => /^(Leu|Rodou|Editou) \d/.test(b.textContent ?? "")) as HTMLButtonElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("as ferramentas em uma linha-resumo", () => {
  it("o print: 1 leitura que falhou e 14 comandos viram uma linha só, recolhida", async () => {
    await render([user, read(), ...Array.from({ length: 14 }, (_, i) => cmd(i + 1)), end], false);
    const group = groupButton();
    expect(group.textContent).toContain("Leu 1 arquivo, rodou 14 comandos");
    expect(group.textContent).toContain("1 falhou");
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain("git log -n 3");
  });

  it("abrir mostra a lista, uma linha por comando", async () => {
    await render([user, read(), ...Array.from({ length: 14 }, (_, i) => cmd(i + 1)), end], false);
    await act(async () => { groupButton().click(); });
    expect(groupButton().getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("git");
    expect([...host.querySelectorAll("button")].filter((b) => b.textContent?.startsWith("Rodou")).length).toBe(14);
  });

  it("uma ferramenta só continua aparecendo como linha, sem resumo", async () => {
    await render([user, cmd(1), end], false);
    expect(groupButton()).toBeUndefined();
    expect(host.textContent).toContain("Rodou");
  });

  it("com o turno rodando mostra a atividade atual e o ponto; depois de terminar, só o resumo", async () => {
    await render([user, cmd(1), cmd(2, { status: "running" })]);
    const group = groupButton();
    expect(group.textContent).toContain("Rodou 2 comandos");
    expect(group.textContent).toContain("git log -n 2 --oneline");
    expect(group.querySelector(".animate-pulse")).not.toBeNull();
    await render([user, cmd(1), cmd(2), end], false);
    expect(groupButton().textContent).not.toContain("git log -n 2");
    expect(groupButton().querySelector(".animate-pulse")).toBeNull();
  });

  it("quem abriu o grupo não o vê fechar quando chegam itens novos", async () => {
    await render([user, cmd(1), cmd(2)]);
    await act(async () => { groupButton().click(); });
    await render([user, cmd(1), cmd(2), cmd(3), cmd(4)]);
    expect(groupButton().getAttribute("aria-expanded")).toBe("true");
    expect(groupButton().textContent).toContain("Rodou 4 comandos");
  });

  it("o texto de exemplo com vários tipos, na ordem e no plural certo", async () => {
    const edit: TimelineItem = { kind: "tool", id: "e1", tool: "edit", path: "/r/a.ts", status: "done" };
    const search: TimelineItem = { kind: "tool", id: "s1", tool: "search", label: "TODO", status: "done" };
    await render([user, edit, { ...edit, id: "e2", path: "/r/b.ts" }, cmd(1), search, end], false);
    expect(groupButton().textContent).toContain("Editou 2 arquivos, rodou 1 comando, buscou 1 vez");
  });
});
