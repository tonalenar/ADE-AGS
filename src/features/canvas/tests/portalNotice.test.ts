import { describe, expect, it } from "vitest";

import { addEdge, addPortal, emptyBoard, reconcile } from "../board";
import { BROWSER_HINT, computerUseHint, portalConnectedNotice } from "../portalNotice";

function boardWithPortal(url = "http://localhost:5173") {
  const { board } = addPortal(reconcile(emptyBoard(), ["a"]), { id: "portal-1", name: "App", url });
  return addEdge(board, "a", "portal-1");
}

describe("aviso do navegador ligado a um agente", () => {
  it("diz ao agente o nome do navegador e como manejá-lo, de qualquer lado da corda", () => {
    const b = boardWithPortal();
    for (const [x, y] of [["a", "portal-1"], ["portal-1", "a"]] as const) {
      const notice = portalConnectedNotice(b, x, y)!;
      expect(notice.agent).toBe("a");
      expect(notice.text).toContain('"App"');
      expect(notice.text).toContain("http://localhost:5173");
      expect(notice.text).toContain("ags portal snapshot");
    }
  });

  it("não avisa quando a corda não é entre um agente e um navegador", () => {
    const b = reconcile(boardWithPortal(), ["a", "b"]);
    expect(portalConnectedNotice(b, "a", "b")).toBeNull();
    expect(portalConnectedNotice(b, "portal-1", "portal-9")).toBeNull();
  });

  it("a tela de um Android é outra coisa: sem aviso de navegador", () => {
    const { board } = addPortal(reconcile(emptyBoard(), ["a"]), { id: "portal-2", name: "Pixel", kind: "android" });
    expect(portalConnectedNotice(addEdge(board, "a", "portal-2"), "a", "portal-2")).toBeNull();
  });

  it("o simulador iOS ligado ensina o sim act como caminho principal, com status e prazo", () => {
    const { board } = addPortal(reconcile(emptyBoard(), ["a"]), { id: "portal-3", name: "iPhone 16", kind: "ios" });
    const notice = portalConnectedNotice(addEdge(board, "a", "portal-3"), "a", "portal-3")!;
    const act = notice.text.indexOf('ags sim act "iPhone 16"');
    expect(act).toBeGreaterThan(0);
    expect(act).toBeLessThan(notice.text.indexOf("ags device shot"));
    expect(notice.text).toContain("sim_act");
    expect(notice.text).toContain("report.status");
    expect(notice.text).toContain("--timeout 300");
  });

  it("a tela do Mac só é ensinada no macOS", () => {
    expect(computerUseHint("MacIntel")).toContain("ags desk act");
    expect(computerUseHint("MacIntel")).toContain("desk_act");
    expect(computerUseHint("MacIntel")).toContain("report.status");
    expect(computerUseHint("Win32")).toBeNull();
    expect(computerUseHint("Linux x86_64")).toBeNull();
  });

  it("a linha de ensino manda abrir o navegador no canvas, não no sistema", () => {
    expect(BROWSER_HINT).toContain("ags portal create");
    expect(BROWSER_HINT).toContain("não abra o navegador do sistema");
  });
});
