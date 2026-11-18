/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Configura flag global para react act em ambiente happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/features/marketplace/store", () => {
  const use = (selector: (s: Record<string, unknown>) => unknown) => selector(store.state);
  return { useMarketplaceStore: Object.assign(use, { getState: () => store.state }) };
});
vi.mock("@/features/skills/store", () => ({
  useSkillsStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ skills: [], loadSkills: () => {} }),
}));
vi.mock("../SkillResultRow", () => ({ SkillResultRow: () => null }));
vi.mock("../useSkillReadme", () => ({ useSkillReadme: () => ({ loading: false, content: null, unavailable: false }) }));
vi.mock("../RegistryFilterSidebar", () => ({ RegistryFilterSidebar: () => null }));
vi.mock("@/shared/ui/Markdown", () => ({ Markdown: () => null }));

import { MarketplacePage } from "../MarketplacePage";

const skill = { registryId: "reg", id: "skill-a", name: "Skill A", description: "", version: "1.0.0", author: "", registryName: "Reg", categories: [] };

function baseState(extra: Record<string, unknown>) {
  return {
    registries: [{ id: "reg", name: "Reg" }],
    skills: [skill],
    loading: false,
    searchingRemote: false,
    installingKey: null,
    refreshingId: null,
    loadRegistries: () => {},
    loadSkills: () => {},
    searchRemote: () => {},
    installSkill: vi.fn(),
    refreshRegistry: () => {},
    ...extra,
  };
}

let host: HTMLDivElement;
let root: Root;

const keydown = (key: string) => new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });

async function mount() {
  await act(async () => { root.render(<MarketplacePage />); });
  return host.querySelector("input") as HTMLInputElement;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
});

describe("MarketplacePage: ⏎ no buscador (A166)", () => {
  it("não instala enquanto outra instalação está em andamento", async () => {
    store.state = baseState({ installingKey: "reg:skill-b" });
    const input = await mount();
    await act(async () => { input.dispatchEvent(keydown("ArrowDown")); });
    await act(async () => { input.dispatchEvent(keydown("Enter")); });
    expect(store.state.installSkill).not.toHaveBeenCalled();
  });

  it("instala a habilidade marcada quando nada está em andamento", async () => {
    store.state = baseState({});
    const input = await mount();
    await act(async () => { input.dispatchEvent(keydown("ArrowDown")); });
    await act(async () => { input.dispatchEvent(keydown("Enter")); });
    expect(store.state.installSkill).toHaveBeenCalledWith("reg", "skill-a");
  });
});
