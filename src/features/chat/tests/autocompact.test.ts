import { describe, expect, it } from "vitest";

import {
  COMPACTION_TTL_MS, DEFAULT_PCT, autoCompactEnabledFor, compactTokens, compactionOf, contextUsageOf, effectivePct, isCompacting, meterTone,
  parseAutoCompactConfig,
} from "../autocompact/model";
import type { TimelineItem } from "../timeline/types";

const usage = (contextTokens: number, contextWindow?: number): TimelineItem => ({ kind: "usage", id: `u${contextTokens}`, tokens: 1, contextTokens, contextWindow });
const compaction = (status: TimelineItem["status"], at: number, extra: Partial<TimelineItem> = {}): TimelineItem =>
  ({ kind: "notice", id: "n:compaction:1", label: "compaction", status, text: "auto", at, ...extra });

describe("configuração do autocompact", () => {
  it("o limiar padrão é 50% (decisão do usuário, 19/11/2026)", () => {
    expect(DEFAULT_PCT).toBe(50);
  });

  it("nasce ligado, com o limiar padrão", () => {
    const cfg = parseAutoCompactConfig(null);
    expect(cfg.enabled).toBe(true);
    expect(autoCompactEnabledFor(cfg, "codex")).toBe(true);
    expect(effectivePct(cfg, "codex")).toBe(DEFAULT_PCT);
  });

  it("o interruptor do agente desliga só ele; o global desliga todos", () => {
    const cfg = parseAutoCompactConfig(JSON.stringify({ enabled: true, agents: { codex: { enabled: false } } }));
    expect(autoCompactEnabledFor(cfg, "codex")).toBe(false);
    expect(autoCompactEnabledFor(cfg, "claude-code")).toBe(true);
    expect(autoCompactEnabledFor(parseAutoCompactConfig(JSON.stringify({ enabled: false })), "claude-code")).toBe(false);
  });

  it("o limiar é limitado a 50–95% e lixo volta ao padrão ligado", () => {
    const cfg = parseAutoCompactConfig(JSON.stringify({ agents: { codex: { thresholdPct: 99 }, "claude-code": { thresholdPct: 10 } } }));
    expect(effectivePct(cfg, "codex")).toBe(95);
    expect(effectivePct(cfg, "claude-code")).toBe(50);
    for (const raw of ["", "lixo", "[]", "null", '{"enabled":"sim"}']) expect(parseAutoCompactConfig(raw).enabled).toBe(true);
  });
});

describe("medidor de contexto", () => {
  it("usa a janela informada pelo provedor", () => {
    const u = contextUsageOf([usage(150_000, 1_000_000)], "claude-code", "opus")!;
    expect([u.used, u.window, Math.round(u.pct), u.windowKnown]).toEqual([150_000, 1_000_000, 15, true]);
  });

  it("o Claude sem janela informada usa a do modelo (200k, ou 1M com [1m])", () => {
    expect(contextUsageOf([usage(100_000)], "claude-code", "opus")).toMatchObject({ window: 200_000, windowKnown: false });
    expect(contextUsageOf([usage(100_000)], "claude-code", "opus[1m]")).toMatchObject({ window: 1_000_000 });
    expect(contextUsageOf([usage(250_000)], "claude-code", "opus")).toMatchObject({ window: 1_000_000 });
  });

  it("o Codex sem janela do app-server fica sem medida: não se inventa", () => {
    expect(contextUsageOf([usage(120_000)], "codex")).toBeNull();
    expect(contextUsageOf([usage(120_000, 258_000)], "codex")).toMatchObject({ window: 258_000 });
  });

  it("lê o último uso e ignora itens sem contexto", () => {
    const items: TimelineItem[] = [usage(10_000, 200_000), { kind: "usage", id: "x", tokens: 5 }, usage(90_000, 200_000)];
    expect(contextUsageOf(items, "claude-code")?.used).toBe(90_000);
    expect(contextUsageOf([], "claude-code")).toBeNull();
  });

  it("o tom do medidor: ok, perto (10 pontos) e acima do limiar", () => {
    expect(meterTone(40, 83)).toBe("ok");
    expect(meterTone(73, 83)).toBe("near");
    expect(meterTone(83, 83)).toBe("over");
  });

  it("depois de compactar, o medidor mostra os tokens de depois, não o último uso de antes", () => {
    const items: TimelineItem[] = [usage(876_000, 1_000_000), compaction("done", 2, { contextTokens: 876_000, tokens: 27_000 })];
    expect(contextUsageOf(items, "claude-code")).toMatchObject({ used: 27_000, window: 1_000_000, windowKnown: true });
  });

  it("um uso novo depois da compactação volta a ser a medida", () => {
    const items: TimelineItem[] = [usage(876_000, 1_000_000), compaction("done", 2, { contextTokens: 876_000, tokens: 27_000 }), usage(40_000, 1_000_000)];
    expect(contextUsageOf(items, "claude-code")?.used).toBe(40_000);
  });

  it("compactação concluída sem os tokens de depois não deixa o uso de antes no medidor", () => {
    const items: TimelineItem[] = [usage(876_000, 1_000_000), compaction("done", 2, { contextTokens: 876_000 })];
    expect(contextUsageOf(items, "claude-code")).toBeNull();
  });

  it("compactação em andamento ou com erro mantém a medida atual", () => {
    expect(contextUsageOf([usage(90_000, 200_000), compaction("running", 2, { contextTokens: 90_000 })], "claude-code")?.used).toBe(90_000);
    expect(contextUsageOf([usage(90_000, 200_000), compaction("error", 2, { output: "falhou" })], "claude-code")?.used).toBe(90_000);
  });

  it("abrevia os tokens", () => {
    expect([compactTokens(950), compactTokens(182_400), compactTokens(1_000_000), compactTokens(1_250_000)]).toEqual(["950", "182k", "1M", "1.25M"]);
  });
});

describe("compactação na timeline", () => {
  it("lê o estado, o gatilho e os tokens antes e depois", () => {
    const running = compactionOf(compaction("running", 1, { text: "ade", contextTokens: 170_000 }))!;
    expect(running).toMatchObject({ state: "running", trigger: "ade", before: 170_000, after: null });
    const done = compactionOf(compaction("done", 2, { contextTokens: 180_000, tokens: 42_000 }))!;
    expect(done).toMatchObject({ state: "done", before: 180_000, after: 42_000 });
    expect(compactionOf(compaction("error", 3, { output: "falhou" }))).toMatchObject({ state: "error", error: "falhou" });
    expect(compactionOf({ kind: "notice", id: "n", label: "resumeLost" })).toBeNull();
  });

  it("a conversa compacta enquanto o último aviso está em andamento e dentro do prazo", () => {
    expect(isCompacting([compaction("running", 1_000)], 2_000)).toBe(true);
    expect(isCompacting([compaction("running", 1_000), compaction("done", 3_000)], 4_000)).toBe(false);
    expect(isCompacting([], 1)).toBe(false);
    expect(isCompacting([compaction("running", 0)], COMPACTION_TTL_MS + 1)).toBe(false);
  });
});
