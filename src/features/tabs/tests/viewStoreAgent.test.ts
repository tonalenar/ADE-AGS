import { beforeEach, describe, expect, it } from "vitest";

import { AGENT_BROWSER_VIEWPORT, useViewTabsStore } from "../viewStore";

describe("navegador aberto por um agente nasce em 1920×1080", () => {
  beforeEach(() => useViewTabsStore.setState({ views: [], portalViews: [], activeViewId: null, keepMountedIds: [] }));

  it("a aba aberta por um agente (com dono) leva a resolução; a da pessoa não", () => {
    const store = useViewTabsStore.getState();
    const mine = store.openBrowser("/p", "http://localhost:3000");
    const agents = useViewTabsStore.getState().openBrowser("/p", "http://localhost:3000", { owner: { kind: "tab", id: "t1", label: "Claude Code" } });
    const views = useViewTabsStore.getState().views;
    expect(views.find((v) => v.id === mine)).not.toHaveProperty("viewport");
    expect(views.find((v) => v.id === agents)).toMatchObject({ viewport: { width: 1920, height: 1080 } });
    expect(AGENT_BROWSER_VIEWPORT).toEqual({ width: 1920, height: 1080 });
  });

  it("a vista de um portal usa a resolução guardada, se houver", () => {
    useViewTabsStore.getState().ensurePortalView("portal-1", "/p", "http://a.test", { width: 1920, height: 1080 });
    useViewTabsStore.getState().ensurePortalView("portal-2", "/p", "http://b.test");
    const [one, two] = useViewTabsStore.getState().portalViews;
    expect(one.viewport).toEqual({ width: 1920, height: 1080 });
    expect(two.viewport).toBeUndefined();
  });
});
