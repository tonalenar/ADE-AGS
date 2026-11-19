import { beforeEach, describe, expect, it, vi } from "vitest";

import { emptyBoard } from "../../board";
import { boardKey, missionBoardKey, useCanvasStore } from "../../store";
import type { Design, DesignDetail } from "../designApi";
import { openDesignOnCanvases } from "../openOnCanvas";
import { useOpenDesignsStore } from "../openStore";
import { useTabsStore } from "@/features/tabs/store";

const fake = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../designApi", () => ({ designApi: { get: (...args: unknown[]) => fake.get(...args) } }));

const detail = (id: string, over: Partial<Design> = {}): DesignDetail => ({
  design: { id, workspace: "C:\\proj", missionId: null, ownerTabId: null, title: id, status: "draft", ...over },
  pages: [], artboards: [], comments: [], versions: {}, notes: [], shapes: [],
});

describe("ags design open marca o design como aberto no canvas dele", () => {
  beforeEach(() => {
    fake.get.mockReset();
    useOpenDesignsStore.setState({ open: {} });
    useCanvasStore.setState({ boards: {} });
    useTabsStore.setState({ tabs: [], activeTabId: null });
  });

  it("design de missão entra no canvas da missão, e não no da pasta", async () => {
    const mission = missionBoardKey("C:\\proj", "m1");
    const folder = boardKey("C:\\proj");
    useCanvasStore.setState({ boards: { [mission]: emptyBoard(), [folder]: emptyBoard() } });
    fake.get.mockResolvedValue(detail("d1", { missionId: "m1" }));
    expect(await openDesignOnCanvases("d1")).toEqual([mission]);
    expect(useOpenDesignsStore.getState().open).toEqual({ [mission]: ["d1"] });
  });

  it("design sem missão entra no canvas da pasta dele", async () => {
    const folder = boardKey("C:\\proj");
    useCanvasStore.setState({ boards: { [folder]: emptyBoard() } });
    fake.get.mockResolvedValue(detail("d2"));
    expect(await openDesignOnCanvases("d2")).toEqual([folder]);
    expect(useOpenDesignsStore.getState().open).toEqual({ [folder]: ["d2"] });
  });

  it("design aberto pela CLI acompanha o canvas da conversa ativa, mesmo sem canvas carregado", async () => {
    useTabsStore.setState({
      tabs: [{ id: "tab-a", cwd: "C:\\proj", agentId: "claude-code" } as never],
      activeTabId: "tab-a",
    });
    fake.get.mockResolvedValue(detail("d-active"));
    const key = boardKey("C:\\proj") + "#s:tab-a";
    expect(await openDesignOnCanvases("d-active")).toEqual([key]);
    expect(useOpenDesignsStore.getState().open).toEqual({ [key]: ["d-active"] });
  });

  it("missão ainda sem canvas é lembrada para quando abrir", async () => {
    useCanvasStore.setState({ boards: { [boardKey("C:\\proj")]: emptyBoard() } });
    fake.get.mockResolvedValue(detail("d3", { missionId: "m9" }));
    expect(await openDesignOnCanvases("d3")).toEqual([missionBoardKey("C:\\proj", "m9")]);
    expect(useOpenDesignsStore.getState().open).toEqual({ [missionBoardKey("C:\\proj", "m9")]: ["d3"] });
  });

  it("design sem pasta nem missão não tem canvas onde abrir", async () => {
    fake.get.mockResolvedValue(detail("d4", { workspace: "", missionId: null }));
    expect(await openDesignOnCanvases("d4")).toEqual([]);
    expect(useOpenDesignsStore.getState().open).toEqual({});
  });

  it("um id antigo, já consolidado, abre o design atual pelo id devolvido", async () => {
    const folder = boardKey("C:\\proj");
    useCanvasStore.setState({ boards: { [folder]: emptyBoard() } });
    fake.get.mockResolvedValue(detail("atual"));
    await openDesignOnCanvases("antigo");
    expect(fake.get).toHaveBeenCalledWith("antigo");
    expect(useOpenDesignsStore.getState().open).toEqual({ [folder]: ["atual"] });
  });
});
