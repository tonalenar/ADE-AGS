import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { StallAlertsBanner, StartupTimeLine } from "../StallAlertsView";
import {
  alertKey,
  currentWaitMs,
  dedupeAlerts,
  sortAlerts,
  startupSummary,
  useStallAlerts,
  waitLabel,
  type StallAlert,
} from "../stallAlerts";

const alert = (over: Partial<StallAlert> = {}): StallAlert => ({ memberName: "Backend", kind: "orchestrator_silent", waitedMs: 180_000, since: 1000, ...over });

describe("seletores de alertas de parada", () => {
  it("ordena orquestrador mudo antes de agente ocioso, depois o mais antigo", () => {
    const sorted = sortAlerts([
      alert({ memberName: "C", kind: "agent_idle", since: 1 }),
      alert({ memberName: "B", since: 50 }),
      alert({ memberName: "A", since: 10 }),
    ]);
    expect(sorted.map((a) => a.memberName)).toEqual(["A", "B", "C"]);
  });

  it("não muta a entrada", () => {
    const input = [alert({ memberName: "B", since: 5 }), alert({ memberName: "A", since: 1 })];
    sortAlerts(input);
    expect(input[0].memberName).toBe("B");
  });

  it("a espera cresce com o relógio e nunca fica abaixo da medida", () => {
    const a = alert({ waitedMs: 120_000, since: 1000 });
    expect(currentWaitMs(a, 1000)).toBe(120_000);
    expect(currentWaitMs(a, 1000 + 300_000)).toBe(300_000);
    expect(currentWaitMs(alert({ waitedMs: 0, since: 5000 }), 1000)).toBe(0);
    expect(waitLabel(a, 1000)).toBe("2 min 00 s");
  });

  it("dedupe mantém um por membro e tipo, o mais antigo", () => {
    const out = dedupeAlerts([alert({ since: 50 }), alert({ since: 10 }), alert({ kind: "agent_idle", since: 70 })]);
    expect(out).toHaveLength(2);
    expect(out.find((a) => a.kind === "orchestrator_silent")?.since).toBe(10);
  });

  it("chave i18n por tipo", () => {
    expect(alertKey("agent_idle")).toBe("missions.stall.kind.agent_idle");
  });

  it("resume o início da missão", () => {
    expect(startupSummary(null).state).toBe("unknown");
    expect(startupSummary({ allWorkingMs: null, pendingNames: [] }).state).toBe("unknown");
    expect(startupSummary({ allWorkingMs: null, pendingNames: ["Codex"] })).toEqual({ state: "waiting", ms: null, pending: ["Codex"] });
    expect(startupSummary({ allWorkingMs: 42_000, pendingNames: [] })).toEqual({ state: "done", ms: 42_000, pending: [] });
  });
});

describe("store de alertas", () => {
  beforeEach(() => useStallAlerts.setState({ alerts: {}, startup: {} }));

  it("guarda ordenado e sem duplicados por missão, e limpa", () => {
    const s = useStallAlerts.getState();
    s.setAlerts("m1", [alert({ memberName: "B", kind: "agent_idle" }), alert({ memberName: "A" }), alert({ memberName: "A", since: 9999 })]);
    expect(useStallAlerts.getState().alerts.m1.map((a) => a.memberName)).toEqual(["A", "B"]);
    s.setStartup("m1", { allWorkingMs: 1000, pendingNames: [] });
    s.clear("m1");
    expect(useStallAlerts.getState().alerts.m1).toBeUndefined();
    expect(useStallAlerts.getState().startup.m1).toBeUndefined();
  });
});

describe("componentes", () => {
  it("não renderiza nada sem alertas (sem falso positivo)", () => {
    expect(renderToStaticMarkup(<StallAlertsBanner alerts={[]} now={0} />)).toBe("");
  });

  it("renderiza um item por alerta, com role=alert", () => {
    const html = renderToStaticMarkup(<StallAlertsBanner alerts={[alert(), alert({ memberName: "Codex", kind: "agent_idle" })]} now={1000} />);
    expect(html).toContain('role="alert"');
    expect(html.match(/<li/g)).toHaveLength(2);
  });

  it("usa a variante compacta no QG", () => {
    expect(renderToStaticMarkup(<StallAlertsBanner alerts={[alert()]} compact now={1000} />)).toContain("ags-hq__detail");
  });

  it("linha de início renderiza os três estados", () => {
    expect(renderToStaticMarkup(<StartupTimeLine startup={{ allWorkingMs: 5000, pendingNames: [] }} />)).toContain("missions.startup.done");
    expect(renderToStaticMarkup(<StartupTimeLine startup={{ allWorkingMs: null, pendingNames: ["X"] }} />)).toContain("missions.startup.waiting");
    expect(renderToStaticMarkup(<StartupTimeLine startup={undefined} compact />)).toContain("missions.startup.unknown");
  });
});
