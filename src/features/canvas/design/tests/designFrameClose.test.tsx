/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NodeProps } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { DesignActionsContext, DesignFrameNode, type DesignActions, type DesignFrameFlowNode } from "../DesignNodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("moldura do design no canvas", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("o X recolhe o design: devolve o id dele ao canvas", () => {
    const onClose = vi.fn();
    const actions: DesignActions = { onEdit: () => {}, onApprove: () => {}, onReject: () => {}, onChoose: () => {}, onClose, editing: null };
    const props = { id: "design-frame:k", data: { title: "Polir/Home", w: 800, h: 600, designId: "d1" } } as unknown as NodeProps<DesignFrameFlowNode>;
    act(() => {
      root.render(<DesignActionsContext.Provider value={actions}><DesignFrameNode {...props} /></DesignActionsContext.Provider>);
    });
    const close = host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("canvas.design.close")}"]`);
    expect(close).not.toBeNull();
    act(() => close!.click());
    expect(onClose).toHaveBeenCalledWith("d1");
  });
});
