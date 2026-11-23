import { beforeEach, describe, expect, it, vi } from "vitest";

const rec = vi.hoisted(() => ({ handler: null as null | ((e: { payload: unknown }) => void), listens: 0, unlistens: 0 }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (e: { payload: unknown }) => void) => {
    rec.listens += 1;
    rec.handler = handler;
    return Promise.resolve(() => { rec.unlistens += 1; });
  },
}));

import { onThreadEvent } from "../threadEvents";

const flush = () => Promise.resolve().then(() => Promise.resolve());

beforeEach(() => { rec.listens = 0; rec.unlistens = 0; rec.handler = null; });

describe("onThreadEvent", () => {
  it("vários consumidores dividem um listener só e os deltas só chegam a quem pede", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onThreadEvent(a);
    const offB = onThreadEvent(b, { deltas: true });
    await flush();
    expect(rec.listens).toBe(1);
    rec.handler!({ payload: { type: "delta", threadId: "t", delta: "x" } });
    rec.handler!({ payload: { type: "phase", threadId: "t" } });
    expect(a.mock.calls.map((c) => c[0].type)).toEqual(["phase"]);
    expect(b.mock.calls.map((c) => c[0].type)).toEqual(["delta", "phase"]);
    offA();
    expect(rec.unlistens).toBe(0);
    offB();
    expect(rec.unlistens).toBe(1);
  });

  it("sair antes de o listener estar pronto o solta assim que fica pronto", async () => {
    const off = onThreadEvent(vi.fn());
    off();
    await flush();
    expect(rec.unlistens).toBe(1);
  });

  it("um consumidor que lança não impede os outros", async () => {
    const bom = vi.fn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const o1 = onThreadEvent(() => { throw new Error("x"); });
    const o2 = onThreadEvent(bom);
    await flush();
    rec.handler!({ payload: { type: "item", threadId: "t" } });
    expect(bom).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    o1(); o2();
  });
});
