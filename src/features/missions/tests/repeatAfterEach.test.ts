import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repeatAfterEach } from "../repeatAfterEach";

describe("ciclo sem sobreposição (repeatAfterEach)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("o próximo passo só é agendado depois que o anterior (assíncrono) terminou", async () => {
    const resolvers: (() => void)[] = [];
    let running = 0;
    let maxRunning = 0;
    const step = vi.fn(() => new Promise<void>((resolve) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      resolvers.push(() => { running -= 1; resolve(); });
    }));
    const stop = repeatAfterEach(step, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(step).toHaveBeenCalledTimes(1);
    // O passo demora 10 ciclos: com setInterval seriam 10 passos juntos.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(step).toHaveBeenCalledTimes(1);
    resolvers[0]();
    await vi.advanceTimersByTimeAsync(999);
    expect(step).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(step).toHaveBeenCalledTimes(2);
    expect(maxRunning).toBe(1);
    stop();
  });

  it("erro do passo (síncrono ou rejeição) é relatado e o laço segue", async () => {
    const errors: unknown[] = [];
    let n = 0;
    const step = vi.fn(() => {
      n += 1;
      if (n === 1) throw new Error("síncrono");
      if (n === 2) return Promise.reject(new Error("assíncrono"));
      return undefined;
    });
    const stop = repeatAfterEach(step, 500, (e) => { errors.push(e); throw new Error("o relato também falha"); });
    await vi.advanceTimersByTimeAsync(1500);
    expect(step).toHaveBeenCalledTimes(3);
    expect(errors.map((e) => (e as Error).message)).toEqual(["síncrono", "assíncrono"]);
    stop();
  });

  it("parar cancela o próximo e não agenda depois do passo em andamento", async () => {
    let resolve!: () => void;
    const step = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const stop = repeatAfterEach(step, 100);
    await vi.advanceTimersByTimeAsync(100);
    stop();
    resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(step).toHaveBeenCalledTimes(1);
  });
});
