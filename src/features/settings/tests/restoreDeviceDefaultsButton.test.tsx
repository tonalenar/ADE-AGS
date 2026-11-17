/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  confirm: vi.fn(),
  changed: vi.fn(),
  restore: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("neogestify-ui-components", () => ({
  Button: ({
    children, disabled, onClick,
  }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void }) => (
    <button type="button" data-testid="restore-defaults" disabled={disabled} onClick={onClick}>{children}</button>
  ),
  useTheme: () => ({ setTheme: () => undefined }),
}));
vi.mock("@/app/icons", () => ({ RefreshIcon: () => null }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: (...a: unknown[]) => mocks.toast(...a) }));
vi.mock("@/shared/ui/appConfirm", () => ({ appConfirm: (...a: unknown[]) => mocks.confirm(...a) }));
vi.mock("@/features/settings/deviceDefaultsModel", () => ({
  changedDeviceDefaults: (...a: unknown[]) => mocks.changed(...a),
  restoreDeviceDefaults: (...a: unknown[]) => mocks.restore(...a),
}));
vi.mock("@/features/settings/deviceDefaults", () => ({
  DEVICE_DEFAULTS: [{ id: "tema", labelKey: "settings.appearance" }],
}));

const { RestoreDeviceDefaultsButton } = await import("../RestoreDeviceDefaultsButton");

describe("RestoreDeviceDefaultsButton", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.toast.mockReset();
    mocks.confirm.mockReset();
    mocks.changed.mockReset();
    mocks.restore.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    act(() => undefined);
  }

  it("falha de leitura no refresh avisa uma vez", async () => {
    mocks.changed.mockRejectedValue({ message: "sem armazenamento" });
    act(() => { root.render(<RestoreDeviceDefaultsButton />); });
    await flush();
    expect(host.querySelector('[data-testid="restore-defaults"]')).toBeTruthy();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast.mock.calls[0]?.[1]).toBe("settings.restoreDefaults.readError");

    act(() => { window.dispatchEvent(new Event("focus")); });
    await flush();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("restore com leitura falha mostra o toast do erro", async () => {
    mocks.changed.mockResolvedValue([{ id: "tema", labelKey: "settings.appearance" }]);
    act(() => { root.render(<RestoreDeviceDefaultsButton />); });
    await Promise.resolve();
    await Promise.resolve();
    act(() => { root.render(<RestoreDeviceDefaultsButton />); });
    const button = host.querySelector<HTMLButtonElement>('[data-testid="restore-defaults"]')!;
    expect(button).toBeTruthy();
    expect(button.disabled).toBe(false);
    mocks.changed.mockRejectedValue({ message: "caiu no restore" });
    act(() => { button.click(); });
    await Promise.resolve();
    await Promise.resolve();
    act(() => { root.render(<RestoreDeviceDefaultsButton />); });
    const restoreToast = mocks.toast.mock.calls.find((call) => call[1] === "caiu no restore");
    expect(restoreToast).toBeDefined();
    expect(String(restoreToast?.[1])).not.toContain("[object Object]");
  });
});
