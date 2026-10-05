import { SUSTAIN_MS } from "@/features/terminal/activity";
import type { NewSpan } from "./timings";

const QUIET_MS = 5000;
interface Turn {
  mission: string;
  actor: string;
  startedMs: number;
  lastOutputMs: number;
  detail: string;
}

/** One tracker owns all turns, including briefings, to avoid duplicate spans. */
export class TurnTracker {
  private turns = new Map<string, Turn>();

  start(tab: string, mission: string, actor: string, at: number, detail = ""): void {
    if (!this.turns.has(tab)) this.turns.set(tab, { mission, actor, startedMs: at, lastOutputMs: at, detail });
    else if (detail) this.turns.get(tab)!.detail = detail;
  }

  sample(
    snapshot: ReadonlyMap<string, { startedMs: number; lastOutputMs: number }>,
    members: ReadonlyMap<string, { mission: string; actor: string }>,
    now: number,
  ): Array<{ mission: string; span: NewSpan }> {
    for (const [tab, output] of snapshot) {
      const member = members.get(tab);
      if (!member) continue;
      if (!this.turns.has(tab) && output.lastOutputMs - output.startedMs >= SUSTAIN_MS) {
        this.start(tab, member.mission, member.actor, output.startedMs);
      }
      const turn = this.turns.get(tab);
      if (turn && output.lastOutputMs >= turn.startedMs) turn.lastOutputMs = output.lastOutputMs;
    }
    const completed: Array<{ mission: string; span: NewSpan }> = [];
    for (const [tab, turn] of this.turns) {
      if (members.has(tab) && turn.lastOutputMs === turn.startedMs && now - turn.startedMs < 20 * 60_000) continue;
      if (members.has(tab) && now - turn.lastOutputMs < QUIET_MS) continue;
      if (turn.lastOutputMs > turn.startedMs) {
        completed.push({ mission: turn.mission, span: {
          kind: "turn", actor: turn.actor, startedMs: turn.startedMs,
          endedMs: turn.lastOutputMs, detail: turn.detail,
        } });
      }
      this.turns.delete(tab);
    }
    return completed;
  }
}

export const missionTurns = new TurnTracker();
