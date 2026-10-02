import { describe, expect, it } from "vitest";

import { ECHO_MS, QUIET_MS, activeAgents, isEcho } from "../activity";

describe("actividad de los agentes", () => {
  it("un agente está activo hasta que se calla QUIET_MS", () => {
    const out = new Map([["a", 1000], ["b", 1000 + QUIET_MS - 1], ["c", 1000 - 1]]);
    // En t = 1000 + QUIET_MS: `a` ya se calló (justo en el límite), `b` sigue, `c` hace rato.
    expect(activeAgents(out, 1000 + QUIET_MS).sort()).toEqual(["b"]);
    expect(activeAgents(out, 1000)).toEqual(["a", "b", "c"]);
    expect(activeAgents(new Map(), 5)).toEqual([]);
  });

  it("lo que llega justo después de teclear es el eco, no trabajo", () => {
    expect(isEcho(1000, 1000 + ECHO_MS - 1)).toBe(true);
    expect(isEcho(1000, 1000 + ECHO_MS)).toBe(false);
    expect(isEcho(undefined, 1000)).toBe(false);
  });
});
