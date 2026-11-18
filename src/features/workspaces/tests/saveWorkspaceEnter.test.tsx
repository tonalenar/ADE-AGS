/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Configura flag global para react act em ambiente happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/features/workspaces/store", () => ({
  useWorkspacesStore: (selector: (s: { saveCurrentAsWorkspace: unknown }) => unknown) =>
    selector({ saveCurrentAsWorkspace: mocks.save }),
}));
vi.mock("@/shared/ui/AppDialog", async () => {
  const React = await import("react");
  return {
    AppDialog: ({ children, footer }: { children: unknown; footer: unknown }) =>
      React.createElement("div", null, children as never, footer as never),
  };
});

import { SaveWorkspaceDialog } from "../SaveWorkspaceDialog";

let host: HTMLDivElement;
let root: Root;

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  mocks.save.mockReset();
  mocks.save.mockImplementation(() => new Promise(() => {}));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
});

describe("SaveWorkspaceDialog: ⏎ repetido não salva duas vezes (A172)", () => {
  it("um segundo ⏎ enquanto salva não chama o salvamento de novo", async () => {
    await act(async () => { root.render(<SaveWorkspaceDialog onClose={() => {}} />); });
    const input = host.querySelector("input") as HTMLInputElement;
    await act(async () => { setValue(input, "meu workspace"); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
});
