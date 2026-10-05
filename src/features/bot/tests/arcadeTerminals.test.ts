import { describe, expect, it } from "vitest";

import { isFinalDelivery } from "../arcadeSignals";
import { agentKind, deriveArcadeScene, deriveHeroes, deriveTower, deriveTrophy, terminalStage } from "../liveArcadeModel";
import { PIXEL_LOGOS, logoPixels, LOGO_SIZE, type LogoKind } from "../platformLogos";
import { heroTargets, levelOfStage } from "../liveArcadeScene";

const scene = deriveArcadeScene({ missionStatus: "running", tasks: [], timings: null, reviews: null });
const tabs = [
  { id: "l", title: "Orquestrador", agentId: "claude" },
  { id: "f", title: "Frontend", agentId: "codex" },
  { id: "q", title: "QA", agentId: "claude" },
];

describe("terminal-driven stages (missions without tasks)", () => {
  it("opening until sustained output, then by role, delivery on final delivery", () => {
    expect(terminalStage("frontend", false, false, "running")).toBe("opening");
    expect(terminalStage("frontend", true, false, "running")).toBe("work");
    expect(terminalStage("qa", true, false, "running")).toBe("tests");
    expect(terminalStage("review", true, false, "running")).toBe("review");
    expect(terminalStage("backend", true, true, "running")).toBe("delivery");
    expect(terminalStage("backend", false, false, "done")).toBe("delivery");
  });

  it("heroes get a floor only when signals are provided", () => {
    const base = { tabs, scene, sustainedTabIds: ["f"], approvalTaskIds: null };
    expect(deriveHeroes(base).every((hero) => hero.stage === null)).toBe(true);
    const heroes = deriveHeroes({ ...base, signals: { workedTabIds: ["f", "q"], deliveredTabIds: ["q"], missionStatus: "running" } });
    const by = Object.fromEntries(heroes.map((hero) => [hero.name, hero]));
    expect(by.Orquestrador.stage).toBe("opening");
    expect(by.Frontend.stage).toBe("work");
    expect(by.Frontend.state).toBe("running");
    expect(by.QA.stage).toBe("delivery");
    expect(by.QA.state).toBe("sleeping");
  });

  it("targets put a task-less hero on its floor beam", () => {
    const targets = heroTargets([{ tabId: "a", taskId: null, stage: "tests" }, { tabId: "b", taskId: null }], new Map());
    expect(targets.get("a")?.level).toBe(levelOfStage("tests"));
    expect(targets.get("b")?.level).toBe(0);
  });

  it("each real final delivery adds one tower block only without tasks", () => {
    const trophy = deriveTrophy(null);
    const deliveries = [{ id: "d1", role: "frontend" as const }, { id: "d2", role: "qa" as const }];
    const tower = deriveTower({ scene, trophy, deliveries });
    expect(tower.done).toBe(2);
    expect(tower.blocks.filter((block) => block.state === "filled")).toHaveLength(2);
    expect(deriveTower({ scene, trophy, deliveries, carrying: new Set(["d2"]) }).done).toBe(1);
    const withTask = deriveArcadeScene({ missionStatus: "running", timings: null, reviews: null,
      tasks: [{ id: "t", title: "t", status: "done", dependsOn: [] }] });
    expect(deriveTower({ scene: withTask, trophy, deliveries }).done).toBe(1);
  });
});

describe("isFinalDelivery", () => {
  const lead = (id: string) => id === "l";
  const msg = (patch: object) => ({ kind: "tell", fromTabId: "f", toTabId: "l", text: "Resultado: ok. Testes: tsc limpo", ...patch });
  it("recognises the briefing-format closing message from a member to the lead", () => {
    expect(isFinalDelivery(msg({}), lead)).toBe(true);
    expect(isFinalDelivery(msg({ text: "ok, valeu" }), lead)).toBe(false);
    expect(isFinalDelivery(msg({ toTabId: "q" }), lead)).toBe(false);
    expect(isFinalDelivery(msg({ fromTabId: "l", toTabId: "f" }), lead)).toBe(false);
    expect(isFinalDelivery(msg({ kind: "ask" }), lead)).toBe(false);
  });
});

describe("platform logos", () => {
  it("every platform has a 12x12 sprite", () => {
    const kinds = Object.keys(PIXEL_LOGOS) as LogoKind[];
    expect(kinds.sort()).toEqual(["antigravity", "claude", "codex", "gemini", "generic", "opencode"]);
    for (const kind of kinds) {
      const { rows } = PIXEL_LOGOS[kind];
      expect(rows).toHaveLength(LOGO_SIZE);
      for (const row of rows) expect(row).toHaveLength(LOGO_SIZE);
      expect(logoPixels(kind).length).toBeGreaterThan(20);
    }
  });
  it("maps agents to a logo kind, shells to none, unknown agents to generic", () => {
    expect(agentKind("gemini-cli")).toBe("gemini");
    expect(agentKind("opencode")).toBe("opencode");
    expect(agentKind("aider")).toBe("generic");
    expect(agentKind("bash")).toBeNull();
    expect(agentKind("powershell")).toBeNull();
  });
});
