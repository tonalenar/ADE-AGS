/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  loadSkillsDir: vi.fn(),
  loadCustomAgents: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@/app/uiStore", () => ({ useUiStore: (sel: (s: { settingsSection: string }) => unknown) => sel({ settingsSection: "general" }) }));
vi.mock("@/features/skills/store", () => ({
  useSkillsStore: (sel: (s: { loadSkillsDir: () => Promise<void> }) => unknown) => sel({ loadSkillsDir: mocks.loadSkillsDir }),
}));
vi.mock("@/features/agents/store", () => ({
  useAgentsStore: (sel: (s: { loadCustomAgents: () => Promise<void> }) => unknown) => sel({ loadCustomAgents: mocks.loadCustomAgents }),
}));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: (...a: unknown[]) => mocks.toast(...a) }));
vi.mock("../RestoreDeviceDefaultsButton", () => ({ RestoreDeviceDefaultsButton: () => null }));
vi.mock("../SettingsSidebar", () => ({ SettingsSidebar: () => null }));
vi.mock("../SettingsPages", () => ({ SettingsPageBody: () => null }));
vi.mock("../settingsNav", () => ({
  SETTINGS_PAGE_LABEL_KEYS: { general: "settings.nav.general" },
  settingsPageDescKey: () => "settings.nav.general.desc",
}));

import { SettingsPage } from "../SettingsPage";

describe("SettingsPage carga inicial", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.loadSkillsDir.mockReset();
    mocks.loadCustomAgents.mockReset();
    mocks.toast.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("mostra toast se a pasta de skills falhar e não usa [object Object] nos agentes", async () => {
    mocks.loadSkillsDir.mockRejectedValue(new Error("pasta"));
    mocks.loadCustomAgents.mockRejectedValue({ message: "lista de agentes" });
    await act(async () => {
      root.render(<SettingsPage />);
    });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.toast).toHaveBeenCalledWith("settings.skillsDir", "settings.skillsDir.readError", "error", 6000);
    const agentToast = mocks.toast.mock.calls.find((call) => call[0] === "settings.agents");
    expect(agentToast?.[1]).toBe("lista de agentes");
    expect(String(agentToast?.[1])).not.toContain("[object Object]");
  });
});
