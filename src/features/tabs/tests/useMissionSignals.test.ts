import { describe, expect, it } from "vitest";

import { missionSignals } from "../useMissionSignals";

describe("missionSignals", () => {
  it("cuenta los terminales sostenidos por misión y marca las alertas", () => {
    const out = missionSignals({ a: "m1", b: "m1", c: "m2" }, ["a", "b", "c", "suelto"], { m2: [{}] }, ["m1", "m2", "m3"]);
    expect(out).toEqual({
      m1: { workingAgents: 2, needsAttention: false },
      m2: { workingAgents: 1, needsAttention: true },
      m3: { workingAgents: 0, needsAttention: false },
    });
  });
});
