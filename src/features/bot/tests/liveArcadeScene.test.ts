import { describe, expect, it } from "vitest";

import { agentKind, deriveArcadeScene, deriveHeroes, deriveTower, newlyDone, roleOf, taskOfTab, type ArcadeTask } from "../liveArcadeModel";
import { BEAM_RIGHT, beamY, heroTargets, jumpLift, ladderX, levelOfStage, patrolOffset, stepMotion, taskSlots, type Motion } from "../liveArcadeScene";

const task = (id: string, patch: Partial<ArcadeTask> = {}): ArcadeTask => ({ id, title: id, status: "pending", dependsOn: [], ...patch });
const sceneOf = (tasks: ArcadeTask[]) => deriveArcadeScene({ missionStatus: "running", tasks, timings: null, reviews: null });

describe("terminal -> herói", () => {
  it("reconhece a plataforma e ignora shells", () => {
    expect(agentKind("claude-code")).toBe("claude");
    expect(agentKind("codex")).toBe("codex");
    expect(agentKind("agy")).toBe("antigravity");
    expect(agentKind("bash")).toBeNull();
  });
  it("seis terminais viram seis heróis, mesmo com a mesma plataforma", () => {
    const tabs = ["a", "b", "c", "d", "e", "f"].map((id, i) => ({ id, title: "T" + id, agentId: i < 3 ? "claude" : "codex" }));
    const heroes = deriveHeroes({ tabs: [...tabs, { id: "sh", title: "bash", agentId: "bash" }], scene: sceneOf([]), sustainedTabIds: [], approvalTaskIds: null });
    expect(heroes).toHaveLength(6);
    expect(heroes.map((h) => h.name)).toEqual(["Ta", "Tb", "Tc", "Td", "Te", "Tf"]);
  });
  it("liga a tarefa pela sessão ou pelo nome do plano, nunca por palpite", () => {
    const tasks = [task("t1", { sessionId: "s1", role: "worker" }), task("t2", { aliases: ["Backend"], status: "running" }), task("t3")];
    expect(taskOfTab({ id: "x", title: "x", agentId: "claude", sessionId: "s1" }, tasks)?.id).toBe("t1");
    expect(taskOfTab({ id: "x", title: " backend ", agentId: "claude" }, tasks)?.id).toBe("t2");
    expect(taskOfTab({ id: "x", title: "outro", agentId: "claude" }, tasks)).toBeNull();
  });
  it("prefere a tarefa ativa à concluída", () => {
    const tasks = [task("old", { aliases: ["api"], status: "done" }), task("now", { aliases: ["api"], status: "running" })];
    expect(taskOfTab({ id: "x", title: "api", agentId: "codex" }, tasks)?.id).toBe("now");
  });
  it("estado: corre só com saída sustentada, '!' com falha ou aprovação, senão dorme", () => {
    const scene = sceneOf([
      task("a", { aliases: ["A"], status: "running" }),
      task("b", { aliases: ["B"], status: "failed" }),
      task("c", { aliases: ["C"], status: "running" }),
      task("d", { aliases: ["D"], status: "running" }),
    ]);
    const tabs = ["A", "B", "C", "D"].map((title) => ({ id: title.toLowerCase(), title, agentId: "claude" }));
    const heroes = deriveHeroes({ tabs, scene, sustainedTabIds: ["a", "b"], approvalTaskIds: ["c"] });
    expect(heroes.map((h) => h.state)).toEqual(["running", "stopped", "stopped", "sleeping"]);
  });
  it("sem tarefa ligada o herói fica no chão (andar desconhecido)", () => {
    const [hero] = deriveHeroes({ tabs: [{ id: "x", title: "Orquestrador", agentId: "claude" }], scene: sceneOf([]), sustainedTabIds: [], approvalTaskIds: null });
    expect(hero.stage).toBeNull();
    expect(hero.taskId).toBeNull();
    expect(hero.role).toBe("lead");
  });
  it("andar do herói = andar da tarefa; cor por papel", () => {
    const scene = sceneOf([task("q", { aliases: ["QA / Tests"], role: "qa", status: "running" })]);
    const [hero] = deriveHeroes({ tabs: [{ id: "x", title: "QA / Tests", agentId: "antigravity" }], scene, sustainedTabIds: [], approvalTaskIds: null });
    expect(hero.stage).toBe("tests");
    expect(hero.role).toBe("qa");
    expect(roleOf("Backend")).toBe("backend");
    expect(roleOf("Frontend")).toBe("frontend");
    expect(roleOf("Revisor", "code-review")).toBe("review");
    expect(roleOf("Fulano")).toBe("other");
  });
});

describe("movimento na cena", () => {
  it("anda até a escada, sobe um andar por vez e chega ao destino", () => {
    let m: Motion = { x: 190, level: 0 };
    const target = { x: 300, level: 3 };
    const seen = new Set<number>();
    for (let i = 0; i < 4000 && (m.x !== target.x || m.level !== target.level); i += 1) {
      m = stepMotion(m, target, 83, 110);
      seen.add(Math.round(m.level));
    }
    expect(m).toEqual(target);
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });
  it("só sobe pela escada do andar (x = escada) e desce também", () => {
    let m: Motion = { x: 500, level: 2 };
    m = stepMotion(m, { x: 500, level: 0 }, 83, 110);
    expect(m.level).toBe(2);
    expect(m.x).toBeLessThan(500);
    for (let i = 0; i < 300 && m.level === 2; i += 1) m = stepMotion(m, { x: 500, level: 0 }, 83, 110);
    expect(m.x).toBe(ladderX(1));
    expect(m.level).toBeLessThan(2);
  });
  it("não anda sem tempo e nunca ultrapassa o destino", () => {
    expect(stepMotion({ x: 100, level: 1 }, { x: 400, level: 1 }, 0, 100)).toEqual({ x: 100, level: 1 });
    expect(stepMotion({ x: 390, level: 1 }, { x: 400, level: 1 }, 1000, 100).x).toBe(400);
  });
  it("vigas inclinadas e interpoladas na escada", () => {
    expect(beamY(2, 158)).not.toBe(beamY(2, BEAM_RIGHT));
    const mid = beamY(1.5, 400);
    expect(mid).toBeGreaterThan(Math.min(beamY(1, 400), beamY(2, 400)) - 1);
    expect(mid).toBeLessThan(Math.max(beamY(1, 400), beamY(2, 400)) + 1);
  });
  it("destinos: tarefa ligada na viga do andar; sem tarefa, no chão; vários na mesma tarefa se afastam", () => {
    const scene = sceneOf([task("w", { role: "worker" }), task("q", { role: "qa" })]);
    const t = heroTargets([
      { tabId: "1", taskId: "w" }, { tabId: "2", taskId: "w" }, { tabId: "3", taskId: "q" }, { tabId: "4", taskId: null }, { tabId: "5", taskId: null },
    ], taskSlots(scene));
    expect(t.get("1")?.level).toBe(levelOfStage("work"));
    expect(t.get("3")?.level).toBe(levelOfStage("tests"));
    expect(t.get("1")?.x).not.toBe(t.get("2")?.x);
    expect(t.get("4")).toEqual({ x: 190, level: 0 });
    expect(t.get("5")?.x).toBeGreaterThan(t.get("4")?.x ?? 0);
  });
  it("patrulha e pulo são limitados", () => {
    for (let ms = 0; ms < 5000; ms += 97) expect(Math.abs(patrolOffset(ms, 1))).toBeLessThanOrEqual(16);
    expect(jumpLift(0)).toBe(12);
    expect(jumpLift(18)).toBe(0);
    expect(jumpLift(-40)).toBe(0);
  });
});

describe("torre", () => {
  const scene = deriveArcadeScene({
    missionStatus: "running", timings: null, reviews: null,
    tasks: [
      { id: "a", title: "a", status: "done", dependsOn: [], role: "backend", endedAt: 20 },
      { id: "b", title: "b", status: "done", dependsOn: [], role: "qa", endedAt: 10 },
      { id: "c", title: "c", status: "running", dependsOn: [] },
      { id: "d", title: "d", status: "cancelled", dependsOn: [] },
    ],
  });
  const none = { step: null, pr: null, ci: null } as const;
  it("um bloco por tarefa concluída, na ordem de conclusão; cancelada não conta", () => {
    const tower = deriveTower({ scene, trophy: none });
    expect(tower.blocks.filter((b) => b.kind === "task").map((b) => [b.id, b.state])).toEqual([["b", "filled"], ["a", "filled"], ["c", "empty"]]);
    expect(tower.done).toBe(2);
    expect(tower.planned).toBe(3);
    expect(tower.complete).toBe(false);
  });
  it("PR e CI sem medida ficam cinza e nunca contam como verde", () => {
    const tower = deriveTower({ scene, trophy: { step: "integrated", pr: null, ci: null } });
    expect(tower.blocks.slice(-3).map((b) => [b.kind, b.state])).toEqual([["integration", "filled"], ["pr", "unmeasured"], ["ci", "unmeasured"]]);
  });
  it("só fica pronta com tudo entregue e integração aplicada", () => {
    const all = deriveArcadeScene({ missionStatus: "running", timings: null, reviews: null, tasks: [{ id: "a", title: "a", status: "done", dependsOn: [] }] });
    expect(deriveTower({ scene: all, trophy: { step: "integration_ready", pr: null, ci: null } }).complete).toBe(false);
    expect(deriveTower({ scene: all, trophy: { step: "integrated", pr: null, ci: null } }).complete).toBe(true);
    expect(deriveTower({ scene: deriveArcadeScene({ missionStatus: "running", timings: null, reviews: null, tasks: [] }), trophy: { step: "integrated", pr: null, ci: null } }).complete).toBe(false);
  });
  it("bloco carregado ainda não está na torre", () => {
    const tower = deriveTower({ scene, trophy: none, carrying: new Set(["a"]) });
    expect(tower.done).toBe(1);
    expect(tower.blocks.find((b) => b.id === "a")?.state).toBe("empty");
  });
  it("detecta só a transição para concluída", () => {
    const tasks: ArcadeTask[] = [task("a", { status: "done" }), task("b", { status: "done" }), task("c", { status: "running" }), task("n", { status: "done" })];
    const prev = new Map<string, ArcadeTask["status"]>([["a", "running"], ["b", "done"], ["c", "running"]]);
    expect(newlyDone(prev, tasks)).toEqual(["a"]);
    expect(newlyDone(null, tasks)).toEqual([]);
  });
});
