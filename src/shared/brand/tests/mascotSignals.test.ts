import { describe, expect, it } from "vitest";

import { FAILED_WINDOW_MS } from "../Mascot";
import { mascotSignalsFrom } from "../mascotSignals";

const MIN = 60_000;
const now = 1_000_000_000;

describe("mascotSignalsFrom", () => {
  it("sem tarefas, o tempo parado conta do último momento ocupado", () => {
    expect(mascotSignalsFrom([], now, now - 12 * MIN)).toEqual({ recentFailure: false, idleMs: 12 * MIN });
  });

  it("a tarefa que terminou por último falhou há pouco: falha recente", () => {
    const tasks = [
      { status: "done", endedAt: now - 20 * MIN },
      { status: "failed", endedAt: now - 2 * MIN },
    ];
    const s = mascotSignalsFrom(tasks, now, now - 30 * MIN);
    expect(s.recentFailure).toBe(true);
    expect(s.idleMs).toBe(2 * MIN);
  });

  it("depois da janela a falha deixa de contar", () => {
    const s = mascotSignalsFrom([{ status: "failed", endedAt: now - FAILED_WINDOW_MS - 1 }], now, 0);
    expect(s.recentFailure).toBe(false);
  });

  it("uma tarefa concluída depois da falha apaga a falha", () => {
    const tasks = [
      { status: "failed", endedAt: now - 4 * MIN },
      { status: "done", endedAt: now - 1 * MIN },
    ];
    expect(mascotSignalsFrom(tasks, now, 0).recentFailure).toBe(false);
  });

  it("tarefas sem fim (rodando) não entram", () => {
    expect(mascotSignalsFrom([{ status: "running", endedAt: null }], now, now - MIN).idleMs).toBe(MIN);
  });
});
