import { describe, expect, it, vi } from "vitest";
import { observeForegroundApp } from "../foregroundApp";

describe("consulta de app em primeiro plano", () => {
  it("consulta ao montar e recuperar foco, sem intervalo", async () => {
    vi.useFakeTimers();
    try {
      const target = new EventTarget();
      const load = vi.fn(async () => "app");
      const update = vi.fn();
      const stop = observeForegroundApp(target, load, update);
      await Promise.resolve();
      expect(update).toHaveBeenCalledWith("app");
      await vi.advanceTimersByTimeAsync(60000);
      expect(load).toHaveBeenCalledTimes(1);
      target.dispatchEvent(new Event("focus"));
      expect(load).toHaveBeenCalledTimes(2);
      stop();
      target.dispatchEvent(new Event("focus"));
      expect(load).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("descarta resposta pendente após trocar de aparelho", async () => {
    let resolve!: (value: string) => void;
    const update = vi.fn();
    const stop = observeForegroundApp(new EventTarget(), () => new Promise<string>((r) => { resolve = r; }), update);
    stop();
    resolve("antigo");
    await Promise.resolve();
    expect(update).not.toHaveBeenCalled();
  });
});
