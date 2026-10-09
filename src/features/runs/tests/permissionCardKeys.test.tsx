/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PermissionCard } from "../PermissionCard";
import type { PendingApproval } from "../types";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const approval = (id: string): PendingApproval => ({ id, taskId: "t", toolName: "Bash", input: { command: "ls" }, askedAt: 0, suggestedRule: null });
const press = (init: KeyboardEventInit) => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })); });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("PermissionCard: teclado", () => {
  it("y e n decidem; com Ctrl/Cmd/Alt não decidem", () => {
    const onDecide = vi.fn();
    act(() => root.render(<PermissionCard approval={approval("1")} onDecide={onDecide} focused />));
    press({ key: "y", ctrlKey: true });
    press({ key: "n", metaKey: true });
    press({ key: "y", altKey: true });
    expect(onDecide).not.toHaveBeenCalled();
    press({ key: "y" });
    expect(onDecide).toHaveBeenCalledWith(true, false);
  });

  it("o pedido seguinte na mesma tarjeta volta a poder ser decidido", () => {
    const onDecide = vi.fn();
    act(() => root.render(<PermissionCard approval={approval("1")} onDecide={onDecide} focused />));
    press({ key: "y" });
    press({ key: "n" }); // ainda ocupada: ignora
    expect(onDecide).toHaveBeenCalledTimes(1);
    act(() => root.render(<PermissionCard approval={approval("2")} onDecide={onDecide} focused />));
    press({ key: "n" });
    expect(onDecide).toHaveBeenCalledTimes(2);
    expect(onDecide).toHaveBeenLastCalledWith(false, false);
  });
});
