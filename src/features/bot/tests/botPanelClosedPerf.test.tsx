// @vitest-environment happy-dom
import { Profiler, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }),
}));
vi.mock("@/shared/brand/Pet", () => ({
  usePetStatus: () => ({ xp: 100, level: 1, progress: 0.5, toNext: 100 }),
  powerTier: () => 0,
  Pet: () => null,
}));
vi.mock("@/features/missions/AutomationResumeBar", () => ({ AutomationResumeBar: () => null }));
vi.mock("@/features/memory/MemoryInbox", () => ({ MemoryInboxButton: () => null }));
vi.mock("@/features/memory/MemoryReviewPanel", () => ({ MemoryReviewPanel: () => null }));
vi.mock("@/features/memory/MemoryContextMetricsCard", () => ({ MemoryContextMetricsCard: () => null }));

import { useCanvasStore } from "@/features/canvas/store";
import { useMissionsStore } from "@/features/missions/store";
import { useConversationsStore } from "@/features/sessions/conversationsStore";
import { useTabsStore } from "@/features/tabs/store";
import { BotPanel } from "../BotPanel";
import { useBotPanelStore } from "../botPanelStore";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useBotPanelStore.setState({ open: false });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.restoreAllMocks();
});

describe("PR-F · BotPanel fechado não assina stores quentes (F-R10)", () => {
  it("não re-renderiza ao mudar canvas, tabs ou missões enquanto fechado, mesmo após abrir e fechar", async () => {
    let commits = 0;
    await act(async () => {
      root.render(
        <Profiler id="bot-panel" onRender={() => { commits += 1; }}>
          <BotPanel />
        </Profiler>,
      );
    });

    // Abre uma vez, muda de aba para "trophies" e fecha (como LazyBotPanel mantém o componente montado).
    await act(async () => { useBotPanelStore.setState({ open: true }); });
    const tabs = [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")];
    expect(tabs.length).toBeGreaterThanOrEqual(4);
    await act(async () => { tabs[3]!.click(); });
    expect(tabs[3]!.getAttribute("aria-selected")).toBe("true");

    await act(async () => { useBotPanelStore.setState({ open: false }); });
    expect(host.querySelector("[role=dialog]")).toBeNull();

    commits = 0;
    await act(async () => {
      useCanvasStore.setState((s) => ({ boards: { ...s.boards, "/p/test": { nodes: {}, edges: [], viewport: { x: 10, y: 20, zoom: 1 } } as never } }));
      useTabsStore.setState((s) => ({ tabs: [...s.tabs] }));
      useMissionsStore.setState((s) => ({ missions: [...s.missions] }));
      useConversationsStore.setState((s) => ({ rows: [...s.rows] }));
    });
    expect(commits).toBe(0);

    // Ao reabrir, preserva a aba escolhida anteriormente ("trophies").
    await act(async () => { useBotPanelStore.setState({ open: true }); });
    const reopenedTabs = [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")];
    expect(reopenedTabs[3]!.getAttribute("aria-selected")).toBe("true");
  });
});
