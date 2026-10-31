// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  items: [] as unknown[],
  diff: { files: [] as { added: number; removed: number; path: string }[], truncated: false, loaded: true, repo: true },
  target: null as unknown,
  pulls: [] as unknown[],
  pullsError: false,
  filesError: false,
  commits: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key}${Object.values(o).length ? `:${Object.values(o).join(",")}` : ""}` : key), i18n: { language: "pt-BR" } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
vi.mock("@/shared/ipc/window", () => ({ homeDir: () => Promise.resolve("/Users/ton") }));
vi.mock("@/features/workspaces/useRepoInfo", () => ({
  useRepoInfo: () => new Map([["/Users/ton/Projects/ADE-AGS", { root: mocks.target ? "/Users/ton/Projects/ADE-AGS" : null, branch: "feat/a", isWorktree: false, changes: {}, changedCount: 0 }]]),
}));
vi.mock("@/features/forge/ipc", () => ({ forgePulls: () => (mocks.pullsError ? Promise.reject(new Error("404 Not Found")) : Promise.resolve(mocks.pulls)), forgePullFiles: () => (mocks.filesError ? Promise.reject(new Error("404 Not Found")) : Promise.resolve([{ additions: 5, deletions: 1 }])) }));
vi.mock("@/features/scm/ScmPanel", () => ({ ScmPanel: () => <div data-testid="scm" /> }));
vi.mock("@/features/scm/ipc", () => ({ scmCommit: () => { mocks.commits += 1; return Promise.resolve(); } }));
vi.mock("../timeline/useConversationTimeline", () => ({ useConversationTimeline: () => ({ timeline: { items: mocks.items, truncated: false }, loaded: true, phase: null }) }));
vi.mock("../useWorkingDiff", () => ({ useWorkingDiff: () => ({ state: mocks.diff, load: () => undefined }) }));
vi.mock("../team/useTeamLive", () => ({ useTeamLive: () => ({ modelOf: () => "Opus 5.5 · alto" }) }));

import { useViewTabsStore } from "@/features/tabs/viewStore";

import type { ConversationCard } from "../chatModel";
import { useChatStore } from "../store";
import { SummaryPane } from "../summary/SummaryPane";

const card: ConversationCard = {
  tabId: "tab-1", title: "Conversa", project: "ADE-AGS", cwd: "/Users/ton/Projects/ADE-AGS", branch: "feat/a", isWorktree: false,
  agentId: "claude-code", agentLabel: "Claude Code", starting: false, active: true, openedAt: 1,
};
const tool = (id: string, kindOfTool: string, path: string) => ({ kind: "tool", id, tool: kindOfTool, path, status: "done" });
const pull = (number: number, sourceBranch: string) => ({ number, title: `PR ${number}`, state: "open", draft: false, author: null, webUrl: "u", createdAt: null, updatedAt: null, comments: null, labels: [], sourceBranch, targetBranch: "dev" });

let root: Root;
let host: HTMLDivElement;
const render = () => act(async () => { root.render(<SummaryPane conversation={card} cwd={card.cwd} tabId="tab-1" />); });
const clickText = async (text: string) => {
  const el = [...host.querySelectorAll("button, [role=button]")].find((b) => b.textContent?.includes(text));
  if (!el) throw new Error(`sem botão ${text}`);
  await act(async () => { (el as HTMLButtonElement).click(); });
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.items = [];
  mocks.diff = { files: [], truncated: false, loaded: true, repo: true };
  mocks.target = null;
  mocks.pulls = [];
  mocks.pullsError = false;
  mocks.filesError = false;
  mocks.commits = 0;
  useChatStore.setState({ panel: "summary", surfaces: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); document.body.querySelectorAll("[role=dialog]").forEach((n) => n.remove()); });

describe("o Resumo do painel", () => {
  it("o ambiente: computador, pasta com o pai na home, branch e modelo", async () => {
    await render();
    expect(host.textContent).toContain("chat.summary.computer");
    expect(host.textContent).toContain("ADE-AGS");
    expect(host.textContent).toContain("~/Projects");
    expect(host.textContent).toContain("feat/a");
  });

  it("o contexto sem tokens é 'não medido' e com tokens mostra os tokens, nunca uma porcentagem", async () => {
    await render();
    expect(host.textContent).toContain("chat.summary.notMeasured");
    mocks.items = [{ kind: "usage", id: "u1", tokens: 88600 }];
    await render();
    expect(host.textContent).toContain("chat.summary.contextTokens");
    expect(host.textContent).not.toContain("%");
  });

  it("as saídas vêm dos arquivos escritos ou editados e o Mostrar mais revela o resto", async () => {
    mocks.items = Array.from({ length: 6 }, (_, i) => tool(String(i), i === 0 ? "write" : "edit", `/r/arq${i}.ts`));
    await render();
    expect(host.textContent).toContain("arq5.ts");
    expect(host.textContent).not.toContain("arq0.ts");
    await clickText("chat.summary.showMore");
    expect(host.textContent).toContain("arq0.ts");
  });

  it("clicar numa saída abre o painel de Arquivos e o arquivo", async () => {
    const open = vi.spyOn(useViewTabsStore.getState(), "openFile").mockImplementation(() => undefined as never);
    mocks.items = [tool("1", "write", "/r/PLANO.md")];
    await render();
    await clickText("PLANO.md");
    expect(useChatStore.getState().panel).toBe("files");
    expect(open).toHaveBeenCalledWith(card.cwd, "/r/PLANO.md");
  });

  it("as alterações: o total do diff e o botão só abre o fluxo de commit, sem commitar", async () => {
    mocks.diff = { files: [{ added: 10, removed: 2, path: "a" }, { added: 5, removed: 1, path: "b" }], truncated: false, loaded: true, repo: true };
    await render();
    expect(host.textContent).toContain("+15");
    expect(host.textContent).toContain("−3");
    expect(document.querySelector("[data-testid=scm]")).toBeNull();
    await clickText("chat.summary.commit");
    expect(document.querySelector("[data-testid=scm]")).not.toBeNull();
    expect(mocks.commits).toBe(0);
  });

  it("sem alterações o botão de commit fica desligado", async () => {
    await render();
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "chat.summary.commit") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("os PRs da branch aparecem quando há integração; sem remoto, o cartão não mostra lista", async () => {
    mocks.pulls = [pull(259, "feat/a"), pull(7, "outra")];
    await render();
    expect(host.textContent).not.toContain("PR 259");
    mocks.target = { path: "tonalenar/ADE-AGS" };
    await render();
    expect(host.textContent).toContain("PR 259");
    expect(host.textContent).toContain("ADE-AGS #259");
    expect(host.textContent).toContain("+5");
    expect(host.textContent).not.toContain("PR 7");
  });

  it("o forge devolvendo 404 (origin sem GitHub, conta fora) NUNCA derruba a tela: o Resumo renderiza sem a lista de PRs", async () => {
    mocks.target = { path: "x" };
    mocks.pullsError = true;
    await render();
    expect(host.textContent).toContain("chat.summary.changes");
    expect(host.textContent).not.toContain("PR 259");
  });

  it("se só a leitura do +/− do PR falha (404), o PR aparece mesmo assim", async () => {
    mocks.target = { path: "x" };
    mocks.pulls = [pull(259, "feat/a")];
    mocks.filesError = true;
    await render();
    expect(host.textContent).toContain("PR 259");
    expect(host.textContent).not.toContain("+5");
  });
});
