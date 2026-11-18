// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rec = vi.hoisted(() => ({ diffs: [] as string[], handlers: {} as Record<string, ((e: { payload: unknown }) => void)[]> }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    (rec.handlers[name] ??= []).push(handler);
    return Promise.resolve(() => undefined);
  },
}));
vi.mock("../ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc")>()),
  scmWorkingDiff: (cwd: string) => { rec.diffs.push(cwd); return Promise.resolve(null); },
}));

import type { ConversationCard } from "../chatModel";
import { useFolderDiffs } from "../ChatShell";
import { useWorkingDiff } from "../useWorkingDiff";

const emit = (name: string, payload: unknown) => { for (const h of rec.handlers[name] ?? []) h({ payload }); };
const card = { tabId: "a", title: "A", project: "repo", cwd: "/repo", branch: null, isWorktree: false, agentId: "claude-code", agentLabel: "Claude Code", starting: false, active: false, openedAt: 1 } as unknown as ConversationCard;

/** Quem mostra o diff da conversa e o `+/−` da pasta, montados juntos: os dois ouvem o mesmo crescimento. */
function Probe() {
  useFolderDiffs([card]);
  useWorkingDiff("/repo", "a");
  return null;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  rec.diffs = [];
  rec.handlers = {};
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.useRealTimers();
});

describe("uma conversa que cresce faz uma leitura do git por pasta", () => {
  it("o crescimento relê a pasta uma vez, mesmo com o Diff e o `+/−` da barra montados", async () => {
    await act(async () => { root.render(<Probe />); });
    rec.diffs = [];
    await act(async () => { emit("cc-conversation-grew", { tabId: "a" }); });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(rec.diffs).toEqual(["/repo"]);
  });
});
