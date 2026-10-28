import { beforeEach, describe, expect, it, vi } from "vitest";
import { focusGeminiViewport, geminiCanvasRect, panelBounds } from "../geometry";
import { addPortal, buildMissionTeam, emptyBoard, reconcile, removePortal, toggleOrchestrator } from "@/features/canvas/board";
import { toPersisted, viewLabels, type ViewTab } from "@/features/tabs/viewTabs";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("Gemini Desktop integration boundaries", () => {
  beforeEach(() => { vi.resetModules(); invoke.mockReset(); });

  it("brings a distant Gemini node into view at usable size on open, including a small ADE window", () => {
    const box={x:5400,y:-3000,w:1000,h:700};
    for (const size of [{width:1296,height:816},{width:680,height:512}]) {
      const vp=focusGeminiViewport(box,size);
      const rect=geminiCanvasRect(box,vp,size);
      expect(rect).not.toBeNull();
      expect(rect!.top).toBeGreaterThanOrEqual(80);
      expect(rect!.left+rect!.width).toBeLessThan(size.width);
      expect(rect!.top+rect!.height).toBeLessThan(size.height-70);
      expect(vp.zoom).toBeLessThanOrEqual(1);
    }
  });

  it("moves and resizes the native surface with the canvas, hiding it before it can cover neighboring UI", () => {
    const box = { x: 20, y: 20, w: 1000, h: 700 };
    expect(geminiCanvasRect(box,{x:40,y:40,zoom:1},{width:1400,height:900})).toEqual({left:61,top:94,width:998,height:665});
    expect(geminiCanvasRect(box,{x:-100,y:40,zoom:1},{width:1400,height:900})).toBeNull();
    expect(geminiCanvasRect(box,{x:40,y:40,zoom:.2},{width:1400,height:900})).toBeNull();
    expect(geminiCanvasRect({x:0,y:0,w:360,h:320},{x:40,y:40,zoom:.82},{width:1400,height:900})).not.toBeNull();
    expect(geminiCanvasRect(box,{x:40,y:40,zoom:.5},{width:1400,height:900})?.width).toBe(499);
  });

  it("keeps Gemini leadership and roles while terminal tabs reconcile, then removes permissions with the node", () => {
    let b = addPortal(emptyBoard(),{id:"portal-g",kind:"gemini"}).board;
    b = toggleOrchestrator(b,"portal-g");
    b = {...b, roles:{"portal-g":"research"}};
    b = reconcile(b,["worker"]);
    expect(b.orchestrators).toEqual(["portal-g"]);
    expect(b.roles["portal-g"]).toBe("research");
    b = removePortal(b,"portal-g");
    expect(b.orchestrators).toEqual([]);
    expect(b.roles["portal-g"]).toBeUndefined();
  });

  it("builds a mixed squad with Gemini as Lead without creating a fake terminal", () => {
    const initial = addPortal(emptyBoard(),{id:"portal-g",kind:"gemini"}).board;
    const b = buildMissionTeam(initial,"portal-g",[{tabId:"worker",roleId:"backend"}]);
    expect(Object.keys(b.nodes)).toEqual(["worker"]);
    expect(b.portals["portal-g"].kind).toBe("gemini");
    expect(b.orchestrators).toContain("portal-g");
    expect(b.edges.some((e) => e.a==="portal-g" && e.b==="worker")).toBe(true);
  });

  it("hides native content under a modal or outside its route, preserving physical scale", () => {
    const rect = { x: 40, y: 70, width: 900, height: 600 };
    expect(panelBounds(rect, 1.25, true, false).visible).toBe(true);
    expect(panelBounds(rect, 1.25, true, true).visible).toBe(false);
    expect(panelBounds(rect, 1.25, false, false).visible).toBe(false);
    expect(panelBounds(rect, 1.25, true, false).scale).toBe(1.25);
  });

  it("keeps the desktop app identity through canvas persistence and tab label rendering", () => {
    const added = addPortal(emptyBoard(), { id: "portal-gemini", kind: "gemini" });
    const restored = JSON.parse(JSON.stringify(added.board));
    expect(restored.portals["portal-gemini"].kind).toBe("gemini");
    const view: ViewTab = { kind: "desktop", app: "gemini", id: "gemini", cwd: "/p", title: "Gemini Desktop" };
    expect(viewLabels([view]).get("gemini")).toEqual({ title: "Gemini Desktop", hint: null });
    expect(toPersisted([view])).toEqual([view]);
  });

  it("finishes a slow attachment before releasing an unmounted panel", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce(undefined);
    const api = await import("../ipc");
    const attach = api.desktopAttach("view");
    const detach = api.desktopDetach("view");
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
    finish({ attached: true }); await attach; await detach;
    expect(invoke.mock.calls.map((call) => call[0])).toEqual(["gemini_desktop_attach", "gemini_desktop_detach"]);
  });

  it("does not strand the cleanup queue after an attachment failure", async () => {
    invoke.mockRejectedValueOnce(new Error("DPI mismatch")).mockResolvedValueOnce(undefined);
    const api = await import("../ipc");
    await expect(api.desktopAttach("view")).rejects.toThrow("DPI mismatch");
    await expect(api.desktopDetach("view")).resolves.toBeUndefined();
  });
});
