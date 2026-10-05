import { describe, expect, it } from "vitest";

import { missionSeconds } from "../../bot/botStats";
import { activeSourceKey, formatActive, type MissionEfficiency, type MissionTimings } from "../timings";

/** El mismo valor que el backend devuelve a la lista (s), al QG/CLI (ms) y al panel (active.ms). */
const ms = 123_456;
const list = { startedAt: 10, endedAt: 400, activeSeconds: Math.floor(ms / 1000) };
const efficiency = { activeMs: ms, activeSource: "mission_active", turnMs: 2_000 } as MissionEfficiency;
const timings = { active: { ms, source: "mission_active" }, turnMs: 2_000 } as MissionTimings;

describe("tiempo activo unificado", () => {
  it("lista, QG/CLI y panel de tiempos muestran el mismo valor", () => {
    const fromList = formatActive(list.activeSeconds * 1000);
    expect(fromList).toBe("2 min 03 s");
    expect(formatActive(efficiency.activeMs)).toBe(fromList);
    expect(formatActive(timings.active.ms)).toBe(fromList);
    expect(missionSeconds(list, 999)).toBe(list.activeSeconds);
  });

  it("sin medición no se inventa un número", () => {
    expect(formatActive(null)).toBeNull();
    expect(activeSourceKey(null)).toBeNull();
  });

  it("cada fuente tiene su rótulo y el detalle por turno no reemplaza al oficial", () => {
    expect(activeSourceKey("mission_active")).toBe("missions.efficiency.source.mission_active");
    expect(activeSourceKey("spans")).toBe("missions.efficiency.source.spans");
    expect(activeSourceKey("wall")).toBe("missions.efficiency.source.wall");
    expect(formatActive(efficiency.turnMs)).not.toBe(formatActive(efficiency.activeMs));
  });
});
