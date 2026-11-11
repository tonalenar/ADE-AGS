// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Cada teste carrega o módulo de novo: o cache de leitura da preferência não pode vazar entre eles. */
type Prefs = typeof import("../sidebar/projectOrderPrefs");
let prefs: Prefs;

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  prefs = await import("../sidebar/projectOrderPrefs");
});

describe("preferências da ordem dos projetos (neste aparelho)", () => {
  it("sem nada gravado, vale o último pedido e nenhuma ordem manual", () => {
    expect(prefs.readProjectOrderPrefs()).toEqual({ mode: "activity", manual: [], created: {} });
  });

  it("grava o modo e lê de volta", () => {
    prefs.saveProjectOrderMode("created");
    expect(prefs.readProjectOrderPrefs().mode).toBe("created");
  });

  it("lixo gravado no aparelho vale o padrão, sem quebrar a barra", () => {
    localStorage.setItem(prefs.PROJECT_ORDER_KEY, "{não é json");
    expect(prefs.readProjectOrderPrefs().mode).toBe("activity");
    localStorage.setItem(prefs.PROJECT_ORDER_KEY, JSON.stringify({ mode: "inventado", manual: "x", created: [1] }));
    expect(prefs.readProjectOrderPrefs()).toEqual({ mode: "activity", manual: [], created: {} });
  });

  it("a ordem manual passa pela normalização de pasta e não repete chaves", () => {
    prefs.saveManualProjectOrder(["/p/a/", "/p/a", "/p/b"]);
    expect(prefs.readProjectOrderPrefs().manual).toEqual(["/p/a", "/p/b"]);
  });

  it("anota a data de aparecimento uma vez só", () => {
    prefs.recordProjectsFirstSeen(["/p/a"], 100);
    prefs.recordProjectsFirstSeen(["/p/a", "/p/b"], 900);
    expect(prefs.readProjectOrderPrefs().created).toEqual({ "/p/a": 100, "/p/b": 900 });
  });

  it("trocar o modo não apaga a ordem manual nem as datas", () => {
    prefs.saveManualProjectOrder(["/p/a"]);
    prefs.recordProjectsFirstSeen(["/p/a"], 100);
    prefs.saveProjectOrderMode("activity");
    expect(prefs.readProjectOrderPrefs()).toEqual({ mode: "activity", manual: ["/p/a"], created: { "/p/a": 100 } });
  });

  it("esquecer um projeto tira só ele da ordem manual e das datas", () => {
    prefs.saveManualProjectOrder(["/p/a", "/p/b"]);
    prefs.recordProjectsFirstSeen(["/p/a", "/p/b"], 100);
    prefs.forgetProjectOrder("/p/a");
    expect(prefs.readProjectOrderPrefs()).toEqual({ mode: "activity", manual: ["/p/b"], created: { "/p/b": 100 } });
  });
});
