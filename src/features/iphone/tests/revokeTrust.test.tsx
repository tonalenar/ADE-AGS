// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const forget = vi.fn<() => Promise<number>>();
vi.mock("@/features/chat/devicesIpc", () => ({ computerUseForget: () => forget() }));

import { RevokeTrust } from "../RevokeTrust";

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  forget.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

const button = () => host.querySelector("button") as HTMLButtonElement;

describe("RevokeTrust", () => {
  it("chama o esquecimento das autorizações e confirma", async () => {
    forget.mockResolvedValue(2);
    act(() => {
      root = createRoot(host);
      root.render(<RevokeTrust />);
    });
    expect(button().textContent).toBe("iphone.agentRevoke.idle");
    await act(async () => button().click());
    expect(forget).toHaveBeenCalledTimes(1);
    expect(button().textContent).toBe("iphone.agentRevoke.done");
  });

  it("mostra a falha sem fingir que revogou", async () => {
    forget.mockRejectedValue(new Error("x"));
    act(() => {
      root = createRoot(host);
      root.render(<RevokeTrust />);
    });
    await act(async () => button().click());
    expect(button().textContent).toBe("iphone.agentRevoke.failed");
  });
});
