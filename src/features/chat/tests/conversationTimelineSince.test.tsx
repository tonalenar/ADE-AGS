// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rec = vi.hoisted(() => ({
  handlers: {} as Record<string, ((e: { payload: unknown }) => void)[]>,
  calls: [] as unknown[],
  replies: [] as unknown[],
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    (rec.handlers[name] ??= []).push(handler);
    return Promise.resolve(() => undefined);
  },
}));
vi.mock("../ipc", () => ({
  conversationTimelineSince: (tabId: string, known: unknown) => { rec.calls.push({ tabId, known }); return Promise.resolve(rec.replies.shift()); },
}));

import { useConversationTimeline } from "../timeline/useConversationTimeline";
import type { Timeline } from "../timeline/types";

const seen: (Timeline | null)[] = [];
function Probe() {
  seen.push(useConversationTimeline("tab-1").timeline);
  return null;
}
const grew = () => act(async () => { for (const h of rec.handlers["cc-conversation-grew"] ?? []) h({ payload: { tabId: "tab-1" } }); });

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  rec.handlers = {}; rec.calls = []; rec.replies = []; seen.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const item = (n: number) => ({ kind: "user", id: `u${n}`, text: `p${n}` });

describe("timeline incremental", () => {
  it("o segundo pedido manda o que já se sabe e, sem mudança, não troca a timeline", async () => {
    rec.replies.push({ rev: 5, truncated: false, total: 2, from: 0, items: [item(1), item(2)] });
    rec.replies.push({ rev: 5, truncated: false, total: 2, from: 2, items: [] });
    rec.replies.push({ rev: 6, truncated: false, total: 3, from: 2, items: [item(3)] });
    await act(async () => { root.render(<Probe />); });
    const first = seen[seen.length - 1]!;
    await grew();
    expect(seen[seen.length - 1]).toBe(first);
    await grew();
    const last = seen[seen.length - 1]!;
    expect(last.items).toHaveLength(3);
    expect(last.items[0]).toBe(first.items[0]);
    expect(rec.calls).toEqual([
      { tabId: "tab-1", known: null },
      { tabId: "tab-1", known: { rev: 5, count: 2 } },
      { tabId: "tab-1", known: { rev: 5, count: 2 } },
    ]);
  });

  it("uma cauda que não encaixa refaz o pedido do zero", async () => {
    rec.replies.push({ rev: 5, truncated: false, total: 1, from: 0, items: [item(1)] });
    rec.replies.push({ rev: 9, truncated: false, total: 9, from: 8, items: [item(9)] });
    rec.replies.push({ rev: 9, truncated: false, total: 2, from: 0, items: [item(1), item(2)] });
    await act(async () => { root.render(<Probe />); });
    await grew();
    expect(rec.calls[2]).toEqual({ tabId: "tab-1", known: null });
    expect(seen[seen.length - 1]!.items).toHaveLength(2);
  });
});
