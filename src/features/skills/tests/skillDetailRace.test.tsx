/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, err) => {
    resolve = ok;
    reject = err;
  });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => ({
  getSkillDetail: vi.fn(),
  alwaysOnSkills: vi.fn(async () => [] as string[]),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: "skill-1" }),
}));
vi.mock("neogestify-ui-components", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AnimateSpin: () => null,
  ArrowLeftIcon: () => null,
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
  CloudIcon: () => null,
  FolderIcon: () => null,
  InfoIcon: () => null,
  Loading: () => <div>loading</div>,
  StackIcon: () => null,
  Tooltip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/features/settings/SettingsSection", () => ({ ChatSwitch: () => null }));
vi.mock("@/shared/openExternalUrl", () => ({ openExternalUrl: vi.fn() }));
vi.mock("../ipc", () => ({
  alwaysOnSkills: () => mocks.alwaysOnSkills(),
  setSkillAlwaysOn: vi.fn(),
}));
vi.mock("../store", () => ({
  useSkillsStore: (sel: (s: { getSkillDetail: typeof mocks.getSkillDetail; updateSkillContent: () => void; forkSkill: () => void }) => unknown) =>
    sel({ getSkillDetail: mocks.getSkillDetail, updateSkillContent: vi.fn(), forkSkill: vi.fn() }),
}));

import { SkillDetailPage } from "../SkillDetailPage";

describe("SkillDetailPage corrida ao desmontar", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.getSkillDetail.mockReset();
    mocks.alwaysOnSkills.mockReset();
    mocks.alwaysOnSkills.mockResolvedValue([]);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("promessa adiada depois do unmount não pinta o detalhe", async () => {
    const pending = deferred<{
      name: string; content: string; version: string; categories: string[];
      compatibleAgents: string[]; author: string | null; license: string | null;
      homepage: string | null; registryName: string | null;
    }>();
    mocks.getSkillDetail.mockReturnValue(pending.promise);
    await act(async () => {
      root.render(<SkillDetailPage />);
    });
    await act(async () => {
      root.unmount();
    });
    root = createRoot(host);
    await act(async () => {
      pending.resolve({
        name: "Detalhe órfão",
        content: "corpo órfão",
        version: "1",
        categories: [],
        compatibleAgents: [],
        author: null,
        license: null,
        homepage: null,
        registryName: null,
      });
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain("Detalhe órfão");
    expect(host.textContent).not.toContain("corpo órfão");
  });
});
