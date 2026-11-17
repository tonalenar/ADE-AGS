/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  scmStatus: vi.fn(),
  scmLog: vi.fn(),
}));
vi.mock("../ipc", () => ({
  scmCheckout: vi.fn(), scmCommit: vi.fn(), scmDiscard: vi.fn(), scmFetch: vi.fn(), scmGenerateCommitMessage: vi.fn(),
  scmInit: vi.fn(), scmLog: mocks.scmLog, scmPull: vi.fn(), scmPush: vi.fn(), scmStage: vi.fn(), scmStatus: mocks.scmStatus, scmUnstage: vi.fn(),
}));

const t = vi.hoisted(() => (key: string) => key);
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }) }));
const NO_REFS = vi.hoisted(() => ({ refs: "current" as const }));
vi.mock("neogestify-ui-components", () => ({
  Button: ({ children, variant: _v, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => <button {...rest}>{children}</button>,
  EmptyState: ({ title }: { title: string }) => <p data-empty>{title}</p>,
  Skeleton: () => <div data-skeleton />,
  AddIcon: () => null, Alert: () => null, ChevronDownIcon: () => null, ChevronRightIcon: () => null, CloudIcon: () => null,
  DocumentIcon: () => null, MinusIcon: () => null, TextArea: () => null, Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/app/icons", () => ({
  BranchIcon: () => null, ExternalIcon: () => null, GithubIcon: () => null, GitlabIcon: () => null,
  PullIcon: () => null, PushIcon: () => null, UndoIcon: () => null,
}));
vi.mock("@/shared/ui/AppDialog", () => ({ AppDialog: () => null }));
vi.mock("@/shared/openExternalUrl", () => ({ openExternalUrl: vi.fn() }));
vi.mock("@/features/tabs/viewStore", () => ({ useViewTabsStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ openDiff: vi.fn(), openFile: vi.fn() }) }));
vi.mock("@/features/forge/SignInButton", () => ({ SignInButton: () => null }));
vi.mock("@/features/forge/useRepoTarget", () => ({ useRepoTarget: () => ({ target: null }) }));
vi.mock("@/features/workspaces/useRepoInfo", () => ({ invalidateRepoInfo: vi.fn() }));
vi.mock("@/shared/useDocumentVisible", () => ({ useDocumentVisible: () => true }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: vi.fn() }));
vi.mock("../BranchMenu", () => ({ BranchMenu: () => null }));
vi.mock("../CommitGraph", () => ({ CommitGraph: () => null }));
vi.mock("../CreateTagDialog", () => ({ CreateTagDialog: () => null }));
vi.mock("../GraphBranchFilter", () => ({
  GraphBranchFilter: () => null,
  logRefs: () => null,
  useGraphRefs: () => [NO_REFS.refs, () => undefined],
  useGraphRefsLabel: () => "",
}));
vi.mock("../writingStyle", () => ({ readCommitWritingPreferences: () => ({}) }));
vi.mock("../TagsSection", () => ({ TagsSection: () => null }));
vi.mock("../WorktreesSection", () => ({ ScmWorktreesSection: () => null }));

import { ScmPanel } from "../ScmPanel";

const hosts: Array<{ host: HTMLDivElement; root: Root }> = [];

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); });
}

function mount(): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  hosts.push({ host, root });
  return host;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scmStatus.mockResolvedValue(null);
  mocks.scmLog.mockResolvedValue([]);
});

afterEach(async () => {
  for (const { host, root } of hosts.splice(0)) {
    await act(async () => { root.unmount(); });
    host.remove();
  }
});

describe("ScmPanel: cada painel lê o próprio estado", () => {
  it("dois painéis: o primeiro não fica no esqueleto quando o segundo lê depois", async () => {
    const first = mount();
    const second = mount();
    await act(async () => {
      hosts[0].root.render(<ScmPanel cwd="/a" />);
      hosts[1].root.render(<ScmPanel cwd="/b" />);
    });
    await flush();
    expect(mocks.scmStatus).toHaveBeenCalledTimes(2);
    expect(first.querySelector("[data-skeleton]")).toBeNull();
    expect(first.querySelector("[data-empty]")?.textContent).toBe("scm.notRepo");
    expect(second.querySelector("[data-empty]")?.textContent).toBe("scm.notRepo");
  });
});
