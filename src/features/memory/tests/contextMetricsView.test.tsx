/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
const i18nResult = { t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k) };
vi.mock("react-i18next", () => ({ useTranslation: () => i18nResult }));

import { MemoryContextMetricsCard } from "../MemoryContextMetricsCard";
import { summarize, toRow, type RunContextMetric } from "../contextMetricsView";

const run = (over: Partial<RunContextMetric> = {}): RunContextMetric => ({
  runId: "run-aaaaaaaa-1111",
  beforeBytes: 10240,
  afterBytes: 4096,
  tokensBefore: 2560,
  tokensAfter: 1024,
    entriesUsed: 6,
  ...over,
});

describe("toRow / summarize", () => {
  it("calcula a redução e mantém as medidas reais", () => {
    const row = toRow(run());
    expect(row.reduction).toBe(60);
    expect(row.beforeBytes).toBe(10240);
    expect(row.shortId).toBe("run-aaaa");
  });

  it("zero vira null (sem dados), nunca zero inventado", () => {
    const row = toRow(run({ beforeBytes: 0, tokensBefore: 0, afterBytes: 0, tokensAfter: 0 }));
    expect(row.beforeBytes).toBeNull();
    expect(row.afterBytes).toBeNull();
    expect(row.tokensBefore).toBeNull();
    expect(row.reduction).toBeNull();
  });

  it("Run antigo (legacy) não tem 'antes': não entra na comparação", () => {
    const s = summarize([run({ legacyContext: true }), run({ runId: "b" })]);
    expect(s.rows[0].beforeBytes).toBeNull();
    expect(s.rows[0].legacy).toBe(true);
    expect(s.total?.runs).toBe(1);
    expect(s.total?.beforeBytes).toBe(10240);
  });

  it("sem nenhum Run comparável o total é null", () => {
    expect(summarize([]).total).toBeNull();
    expect(summarize(undefined).total).toBeNull();
    expect(summarize([run({ legacyContext: true })]).total).toBeNull();
  });

  it("soma os Runs comparáveis", () => {
    const s = summarize([run(), run({ runId: "b", beforeBytes: 20480, afterBytes: 4096 })]);
    expect(s.total).toMatchObject({ beforeBytes: 30720, afterBytes: 8192, runs: 2, reduction: 73 });
  });

  it("ignora valores inválidos (NaN, negativo, string)", () => {
    const row = toRow(run({ beforeBytes: Number.NaN, afterBytes: -5, entriesUsed: -1 }));
    expect(row.beforeBytes).toBeNull();
    expect(row.afterBytes).toBeNull();
    expect(row.entriesUsed).toBe(0);
  });
});

describe("MemoryContextMetricsCard", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    invokeMock.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const render = async () => {
    await act(async () => {
      root.render(<MemoryContextMetricsCard missionId="m1" />);
    });
    await act(async () => {});
  };

  it("pede a métrica da missão e mostra tabela com antes → depois", async () => {
    invokeMock.mockResolvedValue({ runs: [run()] });
    await render();
    expect(invokeMock).toHaveBeenCalledWith("memory_context_metrics", { runId: null, missionId: "m1" });
    expect(host.querySelector("table")).not.toBeNull();
    expect(host.textContent).toContain("10.0 KiB");
    expect(host.textContent).toContain("4.0 KiB");
    expect(host.textContent).toContain("memoryContext.reduction");
  });

  it("Run sem medição mostra 'sem dados' e não 0 B", async () => {
    invokeMock.mockResolvedValue({ runs: [run({ beforeBytes: 0, afterBytes: 0, tokensBefore: 0, tokensAfter: 0 })] });
    await render();
    expect(host.textContent).toContain("memoryContext.noData");
    expect(host.textContent).not.toContain("0 B");
  });

  it("missão sem Runs medidos: estado vazio", async () => {
    invokeMock.mockResolvedValue({ runs: [] });
    await render();
    expect(host.querySelector("table")).toBeNull();
    expect(host.textContent).toContain("memoryContext.noRuns");
  });

  it("erro do IPC: mensagem + sem dados, sem quebrar", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    await render();
    expect(host.textContent).toContain("memoryContext.error");
    expect(host.textContent).toContain("memoryContext.noData");
  });

  it("estado carregando enquanto o IPC não responde", async () => {
    invokeMock.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      root.render(<MemoryContextMetricsCard missionId="m1" />);
    });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("memoryContext.loading");
    expect(host.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
  });

  it("runId com HTML vira texto, nunca elemento", async () => {
    invokeMock.mockResolvedValue({ runs: [run({ runId: "<img src=x onerror=alert(1)>" })] });
    await render();
    expect(host.querySelector("img")).toBeNull();
  });
});
