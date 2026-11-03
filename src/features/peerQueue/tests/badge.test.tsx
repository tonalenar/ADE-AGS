/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invokeMock, useInvokeMock } from "@/test/invokeMock";

import { PeerQueueBadge } from "../PeerQueueBadge";
import type { PeerMessage } from "../types";

const { handlers } = vi.hoisted(() => ({ handlers: [] as (() => void)[] }));
vi.mock("@tauri-apps/api/core", () => import("@/test/invokeMock").then((m) => m.tauriCoreMock()));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_: string, cb: () => void) => { handlers.push(cb); return Promise.resolve(() => {}); },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o && "count" in o ? `${k}:${o.count}` : k) }),
}));

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const msg = (id: number, text: string): PeerMessage => ({
  id, clientId: null, kind: "tell", fromTabId: "lead", fromName: "Líder", toTabId: "t1", toName: "QA", text,
  raw: false, reply: false, state: "queued", position: id, forceNow: false, attempts: 0, createdAt: Date.now(),
  updatedAt: Date.now(), deliveredAt: null, editedAt: null, note: null,
});

let counts = [{ tabId: "t1", count: 2 }];
let queue: PeerMessage[] = [];
let host: HTMLDivElement;
let root: Root;

useInvokeMock();

beforeEach(() => {
  counts = [{ tabId: "t1", count: 2 }];
  queue = [msg(1, "rode os testes\nsegunda linha"), msg(2, "revise o PR")];
  invokeMock
    .on("peer_queue_counts", () => counts)
    .on("peer_queue_list", () => queue)
    .on("peer_queue_edit", ({ text }) => ({ ...queue[0], text }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const byText = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text) || b.getAttribute("aria-label") === text);

describe("selo da fila de mensagens", () => {
  it("some sem fila e mostra quantas esperam", async () => {
    counts = [];
    await act(async () => { root.render(<PeerQueueBadge tabId="t1" name="QA" variant="node" />); });
    await flush();
    expect(host.textContent).toBe("");
    counts = [{ tabId: "t1", count: 2 }];
    await act(async () => { handlers[0]?.(); });
    await flush();
    expect(host.textContent).toContain("peerQueue.badge:2");
  });

  it("abre a lista, manda já, cancela com confirmação e edita o texto", async () => {
    await act(async () => { root.render(<PeerQueueBadge tabId="t1" name="QA" variant="tab" />); });
    await flush();
    await act(async () => { byText("peerQueue.badge:2")!.click(); });
    await flush();
    expect(invokeMock.calls("peer_queue_list")).toContainEqual({ tabId: "t1" });
    expect(document.body.textContent).toContain("rode os testes");
    expect(document.body.textContent).not.toContain("segunda linha");

    invokeMock.once("peer_queue_send_now", () => queue[0]);
    await act(async () => { byText("peerQueue.sendNow")!.click(); });
    await flush();
    expect(invokeMock.calls("peer_queue_send_now")).toEqual([{ id: 1 }]);

    await act(async () => { byText("peerQueue.cancel")!.click(); });
    expect(invokeMock.calls("peer_queue_cancel")).toEqual([]);
    invokeMock.once("peer_queue_cancel", () => queue[0]);
    await act(async () => { byText("peerQueue.cancelConfirm")!.click(); });
    await flush();
    expect(invokeMock.calls("peer_queue_cancel")).toEqual([{ id: 1 }]);

    invokeMock.once("peer_queue_move", () => queue[0]);
    await act(async () => { byText("peerQueue.moveDown")!.click(); });
    await flush();
    expect(invokeMock.calls("peer_queue_move")).toEqual([{ id: 1, delta: 1 }]);

    await act(async () => { byText("peerQueue.edit")!.click(); });
    const area = document.querySelector("textarea")!;
    expect(area.value).toBe("rode os testes\nsegunda linha");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(area, "rode só os de peers");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { byText("peerQueue.save")!.click(); });
    await flush();
    expect(invokeMock.calls("peer_queue_edit")).toEqual([{ id: 1, text: "rode só os de peers" }]);
    expect(document.querySelector("textarea")).toBeNull();
  });
});
