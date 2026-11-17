// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("../teamStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../teamStore")>();
  return { ...actual, startTeams: () => undefined };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
vi.mock("@/features/missions/ScopeOverlapNotice", () => ({ ChatTeamScopeOverlaps: () => null }));

import type { ConversationCard } from "../../chatModel";
import { TeamPanel } from "../TeamPanel";
import { useTeamStore } from "../teamStore";

const team = {
  id: "t1", orchestrator: "tab", agentId: "claude-code", label: "L", cwd: "/", title: "",
  createdAt: 1, updatedAt: 1, headcount: 1, members: [],
};
const conversation: ConversationCard = {
  tabId: "tab", title: "Lead", project: "r", cwd: "/", branch: "main", isWorktree: false,
  agentId: "claude-code", agentLabel: "Claude Code", starting: false, active: true, openedAt: 1,
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useTeamStore.setState({ teams: [team], feeds: {}, targets: {}, told: {}, adding: {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("o vigia do chat na UI", () => {
  it("os bloqueios nascem ligados e «sem progresso» desligado", async () => {
    await act(async () => { root.render(<TeamPanel conversation={conversation} cards={[conversation]} />); });
    expect(host.textContent, host.textContent ?? "").toContain("chat.team.watch.on");
    const labels = [...host.querySelectorAll("label")];
    const watchBox = labels.find((l) => l.textContent?.includes("chat.team.watch.on"))?.querySelector("input") as HTMLInputElement;
    const stallBox = labels.find((l) => l.textContent?.includes("chat.team.watchStall.on"))?.querySelector("input") as HTMLInputElement;
    expect(watchBox.checked).toBe(true);
    expect(stallBox.checked).toBe(false);
  });
});
