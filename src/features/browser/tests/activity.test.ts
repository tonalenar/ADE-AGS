import { describe, expect, it } from "vitest";

import { createActivity, describeWait, NAV_STALE_MS, type ActivityEnv, type SettleOptions } from "../page/activity";
import { waitsReport } from "../agentBridge";

/** Um relógio e um agendador falsos: o teste anda o tempo à mão, sem esperar de verdade. */
function fakeEnv() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let domListener: (() => void) | null = null;
  let readyState = "complete";
  const env: ActivityEnv = {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (h) => { timers.delete(h as number); },
    readyState: () => readyState,
    watchDom: (cb) => { domListener = cb; return () => { domListener = null; }; },
  };
  /** Anda o tempo `ms`, disparando os temporizadores na ordem. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
      await Promise.resolve();
    }
    now = end;
    await Promise.resolve();
  };
  return { env, advance, mutate: () => domListener?.(), setReady: (s: string) => { readyState = s; }, time: () => now };
}

const FAST: SettleOptions = { maxMs: 350, quietMs: 60, netIdleMs: 120, pendingMaxMs: 12_000, minMs: 100 };

describe("activity.settle: espera por estado (E1)", () => {
  it("sem nada pendente, assenta no mínimo e não espera o teto", async () => {
    const f = fakeEnv();
    const a = createActivity(f.env);
    let report: Awaited<ReturnType<typeof a.settle>> | null = null;
    void a.settle(FAST).then((r) => { report = r; });
    await f.advance(99);
    expect(report).toBeNull();
    await f.advance(30);
    expect(report!.reason).toBe("quiet");
    expect(report!.sawPending).toBe(false);
    expect(report!.waitedMs).toBeLessThan(200);
    expect(describeWait(report!)).toBeNull();
  });

  it("uma busca de 8 s por XHR: espera o pedido terminar, a rede ociosa e o DOM quieto (não o teto curto de 350 ms)", async () => {
    const f = fakeEnv();
    const a = createActivity(f.env);
    let report: Awaited<ReturnType<typeof a.settle>> | null = null;
    // A ação (o clique) dispara o pedido ANTES de a espera começar, e a baseline foi marcada antes.
    const baseline = a.liveIds();
    const end = a.begin();
    void a.settle({ ...FAST, baseline }).then((r) => { report = r; });
    await f.advance(7900);
    expect(report).toBeNull();
    end();
    f.mutate(); // a página pinta os resultados
    await f.advance(100);
    expect(report).toBeNull(); // rede ociosa por 120 ms ainda não passou
    await f.advance(100);
    expect(report!.reason).toBe("quiet");
    expect(report!.requests).toBe(1);
    expect(report!.waitedMs).toBeGreaterThanOrEqual(8000);
    expect(describeWait(report!)).toMatch(/^esperou 8,\d s \(1 pedido de rede\) — assentou$/);
  });

  it("um pedido que já estava em voo antes da ação (long-poll) não segura a espera", async () => {
    const f = fakeEnv();
    const a = createActivity(f.env);
    a.begin(); // telemetria eterna, de antes
    let report: Awaited<ReturnType<typeof a.settle>> | null = null;
    void a.settle({ ...FAST, baseline: a.liveIds() }).then((r) => { report = r; });
    await f.advance(200);
    expect(report!.reason).toBe("quiet");
    expect(report!.sawPending).toBe(false);
  });

  it("sem baseline, tudo o que está em voo conta (a página nova que acabou de carregar)", async () => {
    const f = fakeEnv();
    const a = createActivity(f.env);
    const end = a.begin();
    let report: Awaited<ReturnType<typeof a.settle>> | null = null;
    void a.settle({ ...FAST, minMs: 0 }).then((r) => { report = r; });
    await f.advance(1000);
    expect(report).toBeNull();
    end();
    await f.advance(300);
    expect(report!.reason).toBe("quiet");
    expect(report!.requests).toBe(1);
  });

  it("navegação pendente segura até o teto de pendências e o relatório diz que parou nele", async () => {
    const f = fakeEnv();
    const a = createActivity(f.env);
    a.markNavigation();
    let report: Awaited<ReturnType<typeof a.settle>> | null = null;
    void a.settle(FAST).then((r) => { report = r; });
    await f.advance(11_900);
    expect(report).toBeNull();
    await f.advance(200);
    expect(report!.reason).toBe("limit");
    expect(report!.stillPending).toBe(true);
    expect(report!.navigation).toBe(true);
    expect(report!.capMs).toBe(12_000);
    expect(describeWait(report!)).toBe("esperou 12,0 s (navegação pendente) — parou no teto de 12 s com a página ainda carregando");
  });

  it("navegação que foi cancelada (clearNavigation) libera a espera", async () => {
    const f = fakeEnv();
    const a = createActivity(f.env);
    a.markNavigation();
    let report: Awaited<ReturnType<typeof a.settle>> | null = null;
    void a.settle(FAST).then((r) => { report = r; });
    await f.advance(500);
    expect(report).toBeNull();
    a.clearNavigation();
    await f.advance(200);
    expect(report!.reason).toBe("quiet");
    expect(report!.navigation).toBe(true);
  });

  it("uma navegação anunciada que nunca trocou o documento expira sozinha", () => {
    const f = fakeEnv();
    const a = createActivity(f.env);
    a.markNavigation();
    expect(a.navigating()).toBe(true);
    void f.advance(NAV_STALE_MS + 1);
    expect(a.navigating()).toBe(false);
  });

  it("documento em loading conta como pendente", async () => {
    const f = fakeEnv();
    f.setReady("loading");
    const a = createActivity(f.env);
    let report: Awaited<ReturnType<typeof a.settle>> | null = null;
    void a.settle({ ...FAST, minMs: 0 }).then((r) => { report = r; });
    await f.advance(1000);
    expect(report).toBeNull();
    f.setReady("complete");
    await f.advance(200);
    expect(report!.reason).toBe("quiet");
    expect(report!.loading).toBe(true);
  });

  it("DOM que não para de mexer (um carrossel) termina no teto curto, sem pendência", async () => {
    const f = fakeEnv();
    const a = createActivity(f.env);
    let report: Awaited<ReturnType<typeof a.settle>> | null = null;
    void a.settle(FAST).then((r) => { report = r; });
    for (let i = 0; i < 20; i++) { f.mutate(); await f.advance(25); }
    expect(report!.reason).toBe("limit");
    expect(report!.capMs).toBe(350);
    expect(report!.stillPending).toBe(false);
  });

  it("terminar um pedido duas vezes não conta duas vezes", () => {
    const a = createActivity(fakeEnv().env);
    const end = a.begin();
    a.begin();
    end();
    end();
    expect(a.size()).toBe(1);
  });
});

describe("waitsReport: o que o act conta sobre a espera", () => {
  const text = "act \"x\": FEITO\nPassos:\n1. clicou\n\nA página agora (o Jev só escolhe onde tocar: confira o resultado):\n- main";
  it("sem esperas notáveis, o texto não muda", () => {
    expect(waitsReport(text, [])).toBe(text);
  });
  it("entra antes de «A página agora»", () => {
    const out = waitsReport(text, ["digitar e enviar: esperou 8,2 s (navegação pendente) — assentou"]);
    expect(out.indexOf("ESPERA (por estado")).toBeGreaterThan(out.indexOf("Passos:"));
    expect(out.indexOf("ESPERA (por estado")).toBeLessThan(out.indexOf("A página agora"));
    expect(out).toContain("- digitar e enviar: esperou 8,2 s (navegação pendente) — assentou");
  });
});

describe("activity.quietFor: há quanto tempo a rede está quieta (J4)", () => {
  it("conta desde o último pedido que começou ou terminou; sem pedido nenhum, é infinito", async () => {
    const { env, advance } = fakeEnv();
    const activity = createActivity(env);
    expect(activity.quietFor()).toBe(Infinity);
    const end = activity.begin();
    await advance(1000);
    expect(activity.quietFor()).toBe(1000);
    end();
    expect(activity.quietFor()).toBe(0);
    await advance(450);
    // A espera `wait idle` já pode responder: a rede está quieta há mais de 400 ms.
    expect(activity.size() === 0 && activity.quietFor() >= 400).toBe(true);
  });
});
