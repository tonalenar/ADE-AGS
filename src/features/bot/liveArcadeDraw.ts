import type { AgentKind, ArcadeBarrel, ArcadeHero, ArcadeScene, ArcadeStageId, ArcadeTower, ArcadeTrophy, HeroRole } from "./liveArcadeModel";
import type { PlacedBarrel } from "./liveArcadeScene";
import { ARCADE_H, ARCADE_W, BEAM_LEFT, BEAM_RIGHT, LEVEL_BASE_Y, TOWER_LEFT, TOWER_WIDTH, beamY, ladderX, levelOfStage, taskSlots } from "./liveArcadeScene";

const DIM = "#77799b";
const FONT = (px: number) => `${px}px "Press Start 2P", monospace`;
const STAGE_ORDER: ArcadeStageId[] = ["delivery", "review", "tests", "work", "opening"];

export const ROLE_COLOR: Record<HeroRole, string> = {
  lead: "#ffe15a", backend: "#ff9b55", frontend: "#62d8ff", qa: "#55e6b1", review: "#ff8bd0", other: "#c18aff",
};
export const KIND_ACCENT: Record<AgentKind, string> = { claude: "#ff7a3d", codex: "#ffffff", antigravity: "#7affd8" };

/** Cabeça por plataforma: Claude = raios, Codex = viseira, Antigravity = antena. 8 colunas. */
const HEAD: Record<AgentKind, string[]> = {
  claude: ["k.kkkk.k", ".hhhhhh.", ".hdhhdh.", ".hhhhhh."],
  codex: ["..cccc..", ".cccccc.", ".kkkkkk.", ".hhhhhh."],
  antigravity: ["...kk...", "..hhhh..", ".hdhhdh.", "..hhhh.."],
};
const BODY = {
  stand: [".cccccc.", "hcccccch", ".cccccc.", ".dd..dd.", ".dd..dd."],
  walkA: [".cccccc.", "hcccccch", ".cccccc.", ".dd.dd..", "dd...dd."],
  walkB: [".cccccc.", "hcccccch", ".cccccc.", "..dd.dd.", ".dd..dd."],
  climb: ["hcccccch", "h.cccc.h", ".cccccc.", ".dd..dd.", ".d....d."],
  sleep: [".cccccc.", ".cccccc.", ".cccccc.", ".dd..dd.", ".dd..dd."],
};
export type Pose = keyof typeof BODY;

function sprite(ctx: CanvasRenderingContext2D, rows: string[], x: number, y: number, scale: number, palette: Record<string, string>) {
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c += 1) {
      const color = palette[row[c]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x + c * scale), Math.round(y + r * scale), scale, scale);
    }
  });
}

/** Um herói desenhado com os pés em (x, y). */
export function drawHero(ctx: CanvasRenderingContext2D, hero: ArcadeHero, x: number, y: number, pose: Pose, label: string, carrying?: HeroRole) {
  const scale = 2;
  const left = x - 8;
  const top = y - 18 - 2 * scale + 0;
  sprite(ctx, [...HEAD[hero.kind], ...BODY[pose]], left, top - 2, scale, {
    c: ROLE_COLOR[hero.role], h: "#ffe0b8", d: "#161225", k: KIND_ACCENT[hero.kind],
  });
  ctx.font = FONT(6);
  ctx.textAlign = "center";
  ctx.fillStyle = "#f4efff";
  ctx.fillText(label.length > 10 ? label.slice(0, 9) + "…" : label, x, top - 8);
  ctx.textAlign = "left";
  if (carrying) {
    ctx.fillStyle = ROLE_COLOR[carrying];
    ctx.fillRect(x - 6, top - 18, 12, 9);
    ctx.fillStyle = "#161225";
    ctx.fillRect(x - 6, top - 12, 12, 1);
  }
  if (hero.state === "sleeping") {
    ctx.font = FONT(8);
    ctx.fillStyle = "#abb1d8";
    ctx.fillText("Z", x + 10, top + 2);
  } else if (hero.state === "stopped") {
    ctx.font = FONT(10);
    ctx.fillStyle = "#ffe15a";
    ctx.fillText("!", x + 10, top + 4);
  }
}

function pixel(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, size = 4) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), size, size);
}

function taskColor(status: string): string {
  if (status === "done") return "#55e6b1";
  if (status === "running") return "#b6ff58";
  if (status === "failed") return "#ff6b8d";
  if (status === "ready") return "#ffbc62";
  if (status === "cancelled" || status === "skipped") return "#77799b";
  return "#aab0d0";
}

function drawBeam(ctx: CanvasRenderingContext2D, level: number) {
  // O chão segue até a torre, onde os heróis deixam os blocos.
  for (let x = BEAM_LEFT; x < (level === 0 ? ARCADE_W - 20 : BEAM_RIGHT); x += 14) {
    const y = beamY(level, x + 7);
    ctx.fillStyle = level === 0 ? "#734b9d" : "#9a4fd0";
    ctx.fillRect(x, y, 14, 8);
    ctx.fillStyle = level === 0 ? "#b77ae3" : "#d287ff";
    if (((x - BEAM_LEFT) / 14) % 2 === 0) ctx.fillRect(x + 2, y + 2, 10, 3);
  }
}

function drawLadder(ctx: CanvasRenderingContext2D, x: number, lower: number, color: string) {
  const bottom = beamY(lower, x);
  const top = beamY(lower + 1, x);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - 6, bottom); ctx.lineTo(x - 6, top);
  ctx.moveTo(x + 6, bottom); ctx.lineTo(x + 6, top);
  for (let y = top + 6; y < bottom; y += 8) { ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); }
  ctx.stroke();
}

function drawDependency(ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, color: string) {
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

export interface Placed { hero: ArcadeHero; x: number; level: number; pose: Pose; lift: number; carrying?: HeroRole }

/** A torre cresce do chão para cima: um bloco por entrega real; cinza = não medido. */
function drawTower(ctx: CanvasRenderingContext2D, tower: ArcadeTower, label: string) {
  const bottom = LEVEL_BASE_Y[0] - 2;
  const room = bottom - (LEVEL_BASE_Y[5] + 40);
  const h = Math.max(6, Math.min(18, Math.floor(room / tower.blocks.length)));
  tower.blocks.forEach((block, index) => {
    const y = bottom - (index + 1) * h;
    if (block.state === "filled") {
      ctx.fillStyle = ROLE_COLOR[block.role];
      ctx.fillRect(TOWER_LEFT, y, TOWER_WIDTH, h - 1);
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(TOWER_LEFT, y + h - 3, TOWER_WIDTH, 2);
    } else if (block.state === "unmeasured") {
      ctx.fillStyle = "#4b4b60";
      ctx.fillRect(TOWER_LEFT, y, TOWER_WIDTH, h - 1);
      ctx.fillStyle = "#9799b9";
      ctx.font = FONT(Math.min(8, h - 2));
      ctx.textAlign = "center";
      ctx.fillText("?", TOWER_LEFT + TOWER_WIDTH / 2, y + h - 3);
      ctx.textAlign = "left";
    } else {
      ctx.strokeStyle = "#4f4a73";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(TOWER_LEFT + 0.5, y + 0.5, TOWER_WIDTH - 1, h - 2);
      ctx.setLineDash([]);
    }
  });
  ctx.font = FONT(6);
  ctx.fillStyle = tower.complete ? "#ffe15a" : "#9799b9";
  ctx.fillText(label, TOWER_LEFT - 8, bottom - tower.blocks.length * h - 6);
}
export interface DrawLabels {
  arcade: string; team: string; trophy: string; tower: string;
  stage: (stage: ArcadeStageId) => string;
  status: (status: string) => string;
}
export interface DrawInput {
  scene: ArcadeScene; title: string; labels: DrawLabels;
  heroes: Placed[]; barrels: Array<PlacedBarrel<ArcadeBarrel>>; trophy: ArcadeTrophy; tower: ArcadeTower; frame: number;
}

export function drawArcade(ctx: CanvasRenderingContext2D, input: DrawInput) {
  const { scene, labels, frame } = input;
  ctx.clearRect(0, 0, ARCADE_W, ARCADE_H);
  ctx.fillStyle = "#100d24";
  ctx.fillRect(0, 0, ARCADE_W, ARCADE_H);
  for (let i = 0; i < 38; i += 1) pixel(ctx, 18 + ((i * 71) % 910), 18 + ((i * 37) % 55), i % 3 ? "#343052" : "#66558a", 2);

  ctx.font = FONT(10);
  ctx.fillStyle = "#ffe15a";
  ctx.fillText(labels.arcade, 24, 28);
  ctx.font = FONT(8);
  ctx.fillStyle = "#f4efff";
  ctx.fillText(input.title.length > 54 ? input.title.slice(0, 51) + "..." : input.title, 24, 52);
  ctx.fillStyle = "#63dfff";
  ctx.fillText(scene.currentStage ? labels.stage(scene.currentStage) : "—", ARCADE_W - 265, 30);

  const slots = taskSlots(scene);
  for (let lower = 0; lower < 5; lower += 1) drawLadder(ctx, ladderX(lower), lower, lower === 0 ? "#6c5a8c" : "#8a77ad");
  for (const stage of STAGE_ORDER) {
    const level = levelOfStage(stage);
    const data = scene.stages.find((item) => item.id === stage);
    drawBeam(ctx, level);
    const y = LEVEL_BASE_Y[level];
    ctx.font = FONT(7);
    ctx.fillStyle = data?.status === "unknown" ? DIM : "#fff0a0";
    ctx.fillText(labels.stage(stage), 18, y + 5);
    ctx.textAlign = "right";
    ctx.fillStyle = data?.status === "unknown" ? DIM : taskColor(data?.status ?? "");
    ctx.fillText(labels.status(data?.status ?? "unknown"), ARCADE_W - 18, y + 5);
    ctx.textAlign = "left";
  }
  drawBeam(ctx, 0);

  for (const dependency of scene.dependencies) {
    const from = slots.get(dependency.from);
    const to = slots.get(dependency.to);
    if (!from || !to) continue;
    const parent = scene.tasks.find((task) => task.id === dependency.from);
    drawDependency(ctx, { x: from.x, y: beamY(from.level, from.x) - 25 }, { x: to.x, y: beamY(to.level, to.x) - 25 }, parent?.status === "done" ? "#59d7ff" : "#77799b");
  }

  for (const stage of ["work", "tests", "review"] as const) {
    const tasks = scene.tasks.filter((task) => task.stage === stage);
    const nodeWidth = Math.max(34, Math.min(92, 600 / Math.max(1, tasks.length) - 8));
    for (const task of tasks) {
      const slot = slots.get(task.id);
      if (!slot) continue;
      const x = slot.x - nodeWidth / 2;
      const y = beamY(slot.level, slot.x) - 37;
      ctx.fillStyle = "#211a39";
      ctx.fillRect(x, y, nodeWidth, 25);
      ctx.strokeStyle = taskColor(task.status);
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, nodeWidth, 25);
      ctx.font = FONT(6);
      ctx.fillStyle = "#f5efff";
      ctx.textAlign = "center";
      ctx.fillText(task.title.length > 14 ? task.title.slice(0, 11) + "..." : task.title, slot.x, y + 16, nodeWidth - 6);
      ctx.textAlign = "left";
    }
  }

  for (const { barrel, x, level } of input.barrels) {
    const y = beamY(level, x) - 8;
    ctx.fillStyle = "#9b5b2e";
    ctx.fillRect(x - 8, y - 14, 16, 14);
    ctx.fillStyle = "#e0a15a";
    // As cintas do barril giram a cada quadro: só rola quando há animação.
    ctx.fillRect(x - 8, y - 12 + (frame % 4) * 2, 16, 2);
    if (barrel.count > 1) {
      ctx.font = FONT(6);
      ctx.fillStyle = "#fff0a0";
      ctx.fillText(String(barrel.count), x - 3, y - 16);
    }
  }

  const top = LEVEL_BASE_Y[5];
  ctx.fillStyle = input.trophy.step !== null ? "#ffe15a" : DIM;
  ctx.fillRect(826, top - 30, 20, 8);
  ctx.fillRect(832, top - 22, 8, 12);
  ctx.fillRect(826, top - 10, 20, 4);
  ctx.font = FONT(6);
  ctx.fillText(labels.trophy, 812, top + 22);
  drawTower(ctx, input.tower, labels.tower);

  ctx.fillStyle = "#9799b9";
  ctx.fillText(labels.team, 18, ARCADE_H - 10);
  // Mais ao fundo primeiro: quem sobe (nível alto) fica atrás de quem está no chão.
  for (const placed of [...input.heroes].sort((a, b) => b.level - a.level)) {
    const y = beamY(placed.level, placed.x) - placed.lift;
    drawHero(ctx, placed.hero, placed.x, y, placed.pose, placed.hero.name, placed.carrying);
  }
}
