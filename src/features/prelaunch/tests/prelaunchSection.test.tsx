/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const remove = vi.fn();
const state = {
  presets: [{ id: "p1", name: "Dev", command: "npm run dev" }],
  loaded: true,
  loadError: null as string | null,
  load: vi.fn(async () => undefined),
  save: vi.fn(),
  remove,
};
vi.mock("@/features/prelaunch/store", () => ({
  usePrelaunchStore: (selector: (s: typeof state) => unknown) => selector(state),
}));
const confirm = vi.fn();
vi.mock("@/shared/ui/appConfirm", () => ({ appConfirm: (...args: unknown[]) => confirm(...args) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k) }) }));

import { PrelaunchSection } from "../../prelaunch/PrelaunchSection";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  remove.mockReset();
  confirm.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const deleteButton = () => host.querySelector<HTMLButtonElement>("button[aria-label='btn.delete']")!;

describe("pré-lançamento: remover preset (A205)", () => {
  it("remover pede confirmação, e uma falha aparece na tela (não só no console)", async () => {
    confirm.mockResolvedValueOnce(true);
    remove.mockRejectedValueOnce(new Error("disco cheio"));
    act(() => root.render(<PrelaunchSection />));
    await act(async () => { deleteButton().click(); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].tone).toBe("danger");
    expect(remove).toHaveBeenCalledWith("p1");
    expect(host.querySelector("[role='alert']")?.textContent).toContain("disco cheio");
  });

  it("cancelar a confirmação não remove nada", async () => {
    confirm.mockResolvedValueOnce(false);
    act(() => root.render(<PrelaunchSection />));
    await act(async () => { deleteButton().click(); });
    expect(remove).not.toHaveBeenCalled();
  });
});
