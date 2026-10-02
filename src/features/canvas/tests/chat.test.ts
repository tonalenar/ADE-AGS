import { describe, expect, it } from "vitest";

import { THREADS, THREAD_COLOR, inThread, threadCounts, type ChatMessage } from "../ChatPanel";

const msg = (id: string, thread: ChatMessage["thread"], kind: ChatMessage["kind"] = "say"): ChatMessage => ({
  id, thread, kind, text: id, at: 1,
});

describe("chat", () => {
  it("los siete hilos son los mismos que conoce el backend, en el mismo orden", () => {
    // Si se cambia `chat::THREADS` en Rust, esto tiene que cambiar con él.
    expect([...THREADS]).toEqual(["blue", "purple", "pink", "red", "orange", "yellow", "green"]);
    for (const t of THREADS) expect(THREAD_COLOR[t]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("separa los mensajes por hilo sin cambiar su orden", () => {
    const all = [msg("a", "blue", "user"), msg("b", "red"), msg("c", "blue"), msg("d", "green")];
    expect(inThread(all, "blue").map((m) => m.id)).toEqual(["a", "c"]);
    expect(inThread(all, "purple")).toEqual([]);
  });

  it("cuenta los mensajes de cada hilo", () => {
    const counts = threadCounts([msg("a", "blue"), msg("b", "blue"), msg("c", "red")]);
    expect(counts.blue).toBe(2);
    expect(counts.red).toBe(1);
    expect(counts.green).toBe(0);
  });
});
