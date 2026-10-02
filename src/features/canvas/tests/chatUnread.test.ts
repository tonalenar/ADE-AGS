import { describe, expect, it } from "vitest";

import { countUnread, latest, unreadOf } from "../chatUnread";

const m = (thread: string, kind: string, at: number) => ({ thread, kind, at });

describe("no leídos del chat", () => {
  const msgs = [m("blue", "user", 1), m("blue", "say", 2), m("blue", "say", 5), m("red", "say", 3), m("red", "progress", 9)];

  it("cuenta solo las respuestas del agente más nuevas que lo visto", () => {
    expect(countUnread(msgs, (t) => (t === "blue" ? 2 : 0))).toEqual({ blue: 1, red: 1 });
  });

  it("lo que escribe el usuario y el progreso no cuentan", () => {
    expect(countUnread([m("blue", "user", 5), m("blue", "progress", 6)], () => 0)).toEqual({});
  });

  it("sin marca de visto, todo cuenta", () => {
    expect(countUnread(msgs, () => undefined)).toEqual({ blue: 2, red: 1 });
  });

  it("lo último de un hilo y la suma por agente", () => {
    expect(latest(msgs, "blue")).toBe(5);
    expect(latest(msgs, "green")).toBe(0);
    expect(unreadOf({ blue: 2, red: 1 })).toBe(3);
    expect(unreadOf(undefined)).toBe(0);
  });
});
