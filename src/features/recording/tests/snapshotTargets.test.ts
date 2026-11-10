import { describe, expect, it } from "vitest";

import {
  MAIN_TARGET,
  SNAPSHOT_DEFAULT_EVENT,
  isSnapshotFile,
  parseTargetValue,
  reconcileTarget,
  snapshotCaption,
  targetOptions,
  targetValue,
  windowLabel,
  type SnapshotInfo,
  type SnapshotListing,
} from "../snapshotTargets";

const LISTA: SnapshotListing = {
  titles: true,
  displays: [
    { id: 7, main: false, number: 2, pixelWidth: 2560, pixelHeight: 1440, pointsWidth: 2560, pointsHeight: 1440, capturable: true, blocked: null },
    { id: 1, main: true, number: 1, pixelWidth: 3024, pixelHeight: 1964, pointsWidth: 1512, pointsHeight: 982, capturable: true, blocked: null },
  ],
  windows: [
    { id: 101, app: "Safari", title: "Página de teste", capturable: true },
    { id: 102, app: "Terminal", title: null, capturable: true },
  ],
};

function info(over: Partial<SnapshotInfo>): SnapshotInfo {
  return { version: 1, scope: "display", app: null, title: null, displayNumber: 1, capturedAt: "2026-11-10T17:00:00-03:00", ...over };
}

describe("valores do seletor de captura", () => {
  it("o valor de cada alvo vai e volta sem perder o id", () => {
    expect(targetValue(MAIN_TARGET)).toBe("main");
    expect(parseTargetValue("main")).toEqual(MAIN_TARGET);
    expect(parseTargetValue("display:7")).toEqual({ kind: "display", id: 7 });
    expect(parseTargetValue("window:101")).toEqual({ kind: "window", id: 101 });
  });

  it("valor que não é de nenhum alvo vira nada", () => {
    expect(parseTargetValue("window:abc")).toBeNull();
    expect(parseTargetValue("display:")).toBeNull();
    expect(parseTargetValue("qualquer")).toBeNull();
  });

  it("o evento do atalho tem nome próprio do ADE", () => {
    expect(SNAPSHOT_DEFAULT_EVENT).toMatch(/^cc-/);
  });
});

describe("opções do seletor", () => {
  it("começam pela tela principal, depois as outras telas e por fim as janelas", () => {
    const opcoes = targetOptions(LISTA);
    expect(opcoes.map((o) => o.value)).toEqual(["main", "display:7", "window:101", "window:102"]);
    expect(opcoes[0].target).toEqual(MAIN_TARGET);
    expect(opcoes[0].group).toBe("display");
    expect(opcoes[2].group).toBe("window");
  });

  it("sem lista ainda, o seletor mostra só a tela principal", () => {
    expect(targetOptions(null).map((o) => o.value)).toEqual(["main"]);
  });

  it("tela com numeração indefinida ou sem permissão fica desabilitada e diz o motivo", () => {
    const semPermissao: SnapshotListing = {
      titles: false,
      displays: LISTA.displays.map((d) => (d.main ? d : { ...d, capturable: false, blocked: "permission" as const })),
      windows: LISTA.windows.map((w) => ({ ...w, capturable: false })),
    };
    const opcoes = targetOptions(semPermissao);
    expect(opcoes.find((o) => o.value === "main")).toMatchObject({ disabled: false, blocked: null });
    expect(opcoes.find((o) => o.value === "display:7")).toMatchObject({ disabled: true, blocked: "permission" });
    expect(opcoes.find((o) => o.value === "window:101")).toMatchObject({ disabled: true });
  });
});

describe("texto das janelas", () => {
  it("janela sem título mostra só o app e a com título junta app e título", () => {
    expect(windowLabel({ app: "Terminal", title: null })).toBe("Terminal");
    expect(windowLabel({ app: "Safari", title: "Página de teste" })).toBe("Safari — Página de teste");
  });
});

describe("escolha que sai da lista", () => {
  it("volta para a tela principal quando a janela escolhida não existe mais ou está bloqueada", () => {
    expect(reconcileTarget({ kind: "window", id: 999 }, LISTA)).toEqual(MAIN_TARGET);
    const bloqueada: SnapshotListing = { ...LISTA, windows: LISTA.windows.map((w) => ({ ...w, capturable: false })) };
    expect(reconcileTarget({ kind: "window", id: 101 }, bloqueada)).toEqual(MAIN_TARGET);
  });

  it("enquanto a lista não chegou, mantém a escolha", () => {
    expect(reconcileTarget({ kind: "window", id: 101 }, null)).toEqual({ kind: "window", id: 101 });
  });
});

describe("arquivos do SnapShot", () => {
  it("só conta como captura do SnapShot o PNG com o prefixo do app", () => {
    expect(isSnapshotFile("/Users/p/Imagens/ADE AGS/ADE-AGS_SnapShot_2026-11-10_17-00-00_abc.png")).toBe(true);
    expect(isSnapshotFile("/Users/p/Imagens/ADE AGS/foto.png")).toBe(false);
    expect(isSnapshotFile("/Users/p/Imagens/ADE AGS/ADE-AGS_SnapShot_1.json")).toBe(false);
  });
});

describe("legenda do anexo", () => {
  it("sem metadado não há legenda", () => {
    expect(snapshotCaption(null)).toBeNull();
    expect(snapshotCaption(info({ scope: "window", app: null, title: null, displayNumber: null }))).toBeNull();
  });

  it("tela principal, outra tela e janela com app e título", () => {
    expect(snapshotCaption(info({ scope: "display", displayNumber: 1 }))).toEqual({ kind: "main" });
    expect(snapshotCaption(info({ scope: "display", displayNumber: 2 }))).toEqual({ kind: "display", number: 2 });
    expect(snapshotCaption(info({ scope: "window", app: "Safari", title: "Página de teste", displayNumber: null })))
      .toEqual({ kind: "window", app: "Safari", title: "Página de teste" });
  });
});
