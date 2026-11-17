/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listDetails = vi.hoisted(() => vi.fn());

vi.mock("../designApi", () => ({
  designApi: { listDetails: (...args: unknown[]) => listDetails(...args) },
  onDesignChanged: () => () => undefined,
}));

import { useScopedDesigns } from "../useScopedDesigns";

const sample = {
  design: { id: "d1", workspace: "/p", missionId: null, ownerTabId: null, title: "A", status: "draft" as const },
  pages: [], artboards: [], comments: [], versions: {}, notes: [], shapes: [],
};

function Probe() {
  const design = useScopedDesigns({ cwd: "/p", missionId: null });
  return (
    <div>
      <span data-testid="count">{design.details.length}</span>
      <button type="button" onClick={() => void design.reload()}>reload</button>
      {design.loadError ? <div role="alert">{design.loadError}</div> : null}
    </div>
  );
}

async function assentar() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

describe("useScopedDesigns erro transitório", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    listDetails.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("conserva as pranchetas e mostra aviso quando o reload falha", async () => {
    listDetails.mockResolvedValueOnce([sample]);
    act(() => { root.render(<Probe />); });
    await assentar();
    expect(host.querySelector("[data-testid=count]")?.textContent).toBe("1");

    listDetails.mockRejectedValueOnce(new Error("rede"));
    act(() => { host.querySelector("button")?.click(); });
    await assentar();
    expect(host.querySelector("[data-testid=count]")?.textContent).toBe("1");
    expect(host.querySelector("[role=alert]")?.textContent).toBe("canvas.design.reloadFailed");
  });
});
