import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { designApi } from "../designApi";

describe("design_list com detalhe", () => {
  beforeEach(() => invoke.mockReset());

  it("listDetails usa um IPC e não chama design_get", async () => {
    invoke.mockResolvedValue([{
      id: "d1", workspace: "/p", missionId: null, ownerTabId: null, title: "A", status: "draft",
      pages: [{ id: "p1", designId: "d1", name: "Home", order: 0, artboards: [] }],
    }]);
    const details = await designApi.listDetails();
    expect(details).toHaveLength(1);
    expect(details[0].design.id).toBe("d1");
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(["design_list"]);
  });
});
