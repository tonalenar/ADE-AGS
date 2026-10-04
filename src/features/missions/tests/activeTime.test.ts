import { describe, expect, it } from "vitest";

import { accumulate, missionsWorking } from "../activeTime";
import { missionSeconds } from "@/features/bot/botStats";

describe("missionsWorking", () => {
  const index = { t1: "m1", t2: "m1", t3: "m2" };

  it("solo cuenta las misiones en curso con algún agente escribiendo", () => {
    expect(missionsWorking(["t1", "t2", "t3"], index, new Set(["m1"]))).toEqual(["m1"]);
  });

  it("con todos los agentes quietos no hay nada trabajando", () => {
    expect(missionsWorking([], index, new Set(["m1", "m2"]))).toEqual([]);
  });

  it("ignora pestañas que no son de ninguna misión", () => {
    expect(missionsWorking(["x"], index, new Set(["m1"]))).toEqual([]);
  });
});

describe("accumulate", () => {
  it("suma un tic por misión sin tocar el mapa original", () => {
    const base = new Map([["m1", 1000]]);
    const next = accumulate(base, ["m1", "m2"], 1000);
    expect(next.get("m1")).toBe(2000);
    expect(next.get("m2")).toBe(1000);
    expect(base.get("m1")).toBe(1000);
  });
});

describe("missionSeconds (tiempo activo)", () => {
  it("usa el tiempo activo, no el reloj de pared", () => {
    expect(missionSeconds({ startedAt: 100, endedAt: 10_000, activeSeconds: 90 }, 20_000)).toBe(90);
  });

  it("una misión en curso con agentes quietos no avanza con el reloj", () => {
    expect(missionSeconds({ startedAt: 100, endedAt: null, activeSeconds: 30 }, 99_999)).toBe(30);
  });

  it("las anteriores a la medición caen al reloj de pared", () => {
    expect(missionSeconds({ startedAt: 100, endedAt: 400, activeSeconds: null }, 999)).toBe(300);
    expect(missionSeconds({ startedAt: 100, endedAt: 400 }, 999)).toBe(300);
  });
});

import { estimateOf, formatUsd, type MissionTokens } from "../tokens";

describe("estimateOf / formatUsd", () => {
  const agent = (estimate: MissionTokens["agents"][number]["estimate"]) => ({
    agentId: "claude-code", measured: true, input: 1, output: 1, cacheWrite: 0, cacheRead: 0, costUsd: null, estimate,
  });

  it("suma el costo y el ahorro de los agentes medidos y junta los modelos sin precio", () => {
    const data: MissionTokens = { agents: [
      agent({ costUsd: 1.5, savedUsd: 2, unpricedModels: ["x"] }),
      agent({ costUsd: 0.5, savedUsd: 1, unpricedModels: ["x", "y"] }),
      { ...agent(null), agentId: "codex", measured: false },
    ] };
    expect(estimateOf(data)).toEqual({ costUsd: 2, savedUsd: 3, unpricedModels: ["x", "y"] });
  });

  it("sin tokens medidos no hay estimación (nunca 0 inventado)", () => {
    expect(estimateOf({ agents: [{ ...agent(null), measured: false }] })).toBeNull();
    expect(estimateOf(null)).toBeNull();
  });

  it("formatea en US$ con coma y — sin dato", () => {
    expect(formatUsd(1.234)).toBe("US$ 1,23");
    expect(formatUsd(null)).toBe("—");
  });
});
