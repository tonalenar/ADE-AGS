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
  params: { id: "skill-a" },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: mocks.params.id }),
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

function detail(name: string) {
  return {
    name,
    content: `corpo ${name}`,
    version: "1",
    categories: [],
    compatibleAgents: [],
    author: null,
    license: null,
    homepage: null,
    registryName: null,
  };
}

describe("SkillDetailPage corrida ao trocar id", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.getSkillDetail.mockReset();
    mocks.alwaysOnSkills.mockReset();
    mocks.alwaysOnSkills.mockResolvedValue([]);
    mocks.params.id = "skill-a";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("o detalhe de A em voo não substitui B", async () => {
    const pendingA = deferred<ReturnType<typeof detail>>();
    const pendingB = deferred<ReturnType<typeof detail>>();
    mocks.getSkillDetail.mockImplementation((id: string) => (
      id === "skill-a" ? pendingA.promise : pendingB.promise
    ));

    await act(async () => {
      root.render(<SkillDetailPage />);
    });
    mocks.params.id = "skill-b";
    await act(async () => {
      root.render(<SkillDetailPage />);
    });

    await act(async () => {
      pendingB.resolve(detail("Bravo"));
      await Promise.resolve();
    });
    expect(host.textContent).toContain("Bravo");
    expect(host.textContent).toContain("corpo Bravo");
    expect(host.textContent).not.toContain("Alfa");

    await act(async () => {
      pendingA.resolve(detail("Alfa"));
      await Promise.resolve();
    });
    expect(host.textContent).toContain("Bravo");
    expect(host.textContent).toContain("corpo Bravo");
    expect(host.textContent).not.toContain("Alfa");
    expect(host.textContent).not.toContain("corpo Alfa");
  });
});
