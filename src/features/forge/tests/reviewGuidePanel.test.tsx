/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error flag global do act do React no happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openNewAgentWith: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("@/features/tabs/tabActions", () => ({ openNewAgentWith: mocks.openNewAgentWith }));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o?.n !== undefined && o?.total !== undefined ? `${k}:${o.n}/${o.total}` : k),
    i18n: { language: "pt-BR" },
  }),
}));

import { ReviewGuidePanel } from "../ReviewGuidePanel";
import { useReviewGuideStore } from "../reviewGuideStore";
import type { ForgeItem, GuideEntry, GuideLookup } from "../types";

const item: ForgeItem = {
  number: 7, title: "Cota", state: "open", draft: false, author: null, webUrl: "https://github.com/o/r/pull/7",
  createdAt: null, updatedAt: null, comments: null, labels: [], sourceBranch: "feat/x", targetBranch: "dev",
};

const entry: GuideEntry = {
  version: 1, repo: "o/r", number: 7, headSha: "aaa111", createdAt: 1, agentId: "claude-code", model: null,
  costUsd: 0.12, attempts: 1,
  guide: {
    summary: "Resumo do PR.",
    risk: "high",
    stops: [
      { id: "um", title: "Primeira", files: [{ path: "a.ts" }], why: "Porque sim.", lookClosely: ["detalhe 1"] },
      { id: "dois", title: "Segunda", files: [{ path: "b.ts", lines: { start: 2, end: 2 } }], why: "Outra razão.", lookClosely: ["detalhe 2"] },
    ],
  },
};

let host: HTMLDivElement;
let root: Root;

function respond(lookup: GuideLookup) {
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "review_guide_get") return lookup;
    if (cmd === "run_roster") return { agents: [] };
    if (cmd === "forge_pull_files") return [{ path: "b.ts", oldPath: null, status: "modified", additions: 1, deletions: 0, patch: "@@ -1,1 +1,2 @@\n x\n+novo" }];
    if (cmd === "review_guide_generate") return { entry, raw: null, errors: [], agentId: "claude-code", model: null };
    throw new Error(`inesperado: ${cmd}`);
  });
}

async function mount() {
  await act(async () => {
    root.render(<ReviewGuidePanel cwd="/repo" item={item} workspaces={[{ cwd: "/repo", branch: "dev" }]} />);
  });
  await act(async () => { await Promise.resolve(); });
}

const text = () => host.textContent ?? "";
const button = (label: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useReviewGuideStore.setState({ jobs: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("ReviewGuidePanel", () => {
  it("sem guia: oferece gerar, e gerar mostra o roteiro", async () => {
    respond({ entry: null, headSha: "aaa111", stale: false });
    await mount();
    expect(text()).toContain("forge.guide.intro");
    await act(async () => { button("forge.guide.generate")!.click(); });
    await act(async () => { await Promise.resolve(); });
    const gen = mocks.invoke.mock.calls.find(([cmd]) => cmd === "review_guide_generate");
    expect(gen?.[1]).toMatchObject({ cwd: "/repo", number: 7, request: { agentId: null, autoAccount: true, lang: "pt-BR", workdir: "/repo" } });
    expect(text()).toContain("Resumo do PR.");
    expect(text()).toContain("forge.guide.stopOf:1/2");
  });

  it("com guia: passo a passo pelas paradas, com teclado, e marca visitadas", async () => {
    respond({ entry, headSha: "aaa111", stale: false });
    await mount();
    expect(text()).toContain("Porque sim.");
    expect(text()).toContain("forge.guide.risk.high");
    expect(text()).not.toContain("forge.guide.stale");

    await act(async () => { button("forge.guide.next")!.click(); });
    expect(text()).toContain("Outra razão.");
    expect(JSON.parse(localStorage.getItem("cc-review-guide-visited:o/r#7@aaa111")!)).toEqual(["um", "dois"]);

    const tour = host.querySelector<HTMLDivElement>("[tabindex='0']")!;
    await act(async () => { tour.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    expect(text()).toContain("Porque sim.");
  });

  it("desatualizado quando o PR andou", async () => {
    respond({ entry, headSha: "bbb222", stale: true });
    await mount();
    expect(text()).toContain("forge.guide.stale");
    expect(text()).toContain("forge.guide.staleHint");
  });

  it("abrir um arquivo mostra o diff com a linha em foco", async () => {
    respond({ entry, headSha: "aaa111", stale: false });
    await mount();
    await act(async () => { button("forge.guide.next")!.click(); });
    await act(async () => { button("b.ts")!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(text()).toContain("+novo");
    expect(host.querySelector(".ring-1")?.textContent).toContain("+novo");
  });

  it("perguntar abre um agente novo com o texto pré-preenchido, sem enviar", async () => {
    respond({ entry, headSha: "aaa111", stale: false });
    await mount();
    await act(async () => { button("forge.guide.ask")!.click(); });
    expect(mocks.openNewAgentWith).toHaveBeenCalledTimes(1);
    const arg = mocks.openNewAgentWith.mock.calls[0][0];
    expect(arg.cwd).toBe("/repo");
    expect(arg.prompt).toBeUndefined();
    expect(arg.draft).toContain("## Stop 1 of 2: Primeira");
  });

  it("nada é publicado: só leituras e a geração local", async () => {
    respond({ entry, headSha: "aaa111", stale: false });
    await mount();
    await act(async () => { button("forge.guide.next")!.click(); });
    await act(async () => { button("forge.guide.ask")!.click(); });
    const cmds = mocks.invoke.mock.calls.map(([cmd]) => cmd as string);
    expect(cmds.every((c) => ["review_guide_get", "run_roster", "forge_pull_files", "review_guide_generate"].includes(c))).toBe(true);
  });
});
