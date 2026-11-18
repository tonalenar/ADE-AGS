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
  forgeReleases: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("neogestify-ui-components", () => ({
  AddIcon: () => null,
  ArrowLeftIcon: () => null,
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
  EmptyState: ({ title }: { title?: string }) => <div>{title}</div>,
  Skeleton: () => <div>loading</div>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/app/icons", () => ({ ExternalIcon: () => null, RefreshIcon: () => null, TagIcon: () => null }));
vi.mock("@/shared/ui/Markdown", () => ({ Markdown: () => null }));
vi.mock("@/shared/openExternalUrl", () => ({ openExternalUrl: vi.fn() }));
vi.mock("@/features/workspaces/useRepoInfo", () => ({ elapsed: () => "" }));
vi.mock("../CreateReleaseDialog", () => ({ CreateReleaseDialog: () => null }));
vi.mock("../ForgeItemsView", () => ({ ForgeErrorView: ({ error }: { error: { message: string } }) => <div>{error.message}</div> }));
vi.mock("../ipc", () => ({
  forgeReleases: (...a: unknown[]) => mocks.forgeReleases(...a),
  forgeImage: vi.fn(),
  resolveForgeImage: vi.fn(),
}));

import { ReleasesView } from "../ReleasesView";
import type { Release, RepoTarget } from "../types";

const target: RepoTarget = {
  root: "/repo",
  remote: "origin",
  remoteUrl: "https://github.com/o/r",
  host: "github.com",
  path: "o/r",
  kind: "github",
  account: {
    id: "a1", kind: "github", host: "github.com", login: "me", name: null, avatarUrl: null,
    auth: "oauth", gitUser: null, createdAt: 1, storage: "keyring",
  },
  accounts: [],
  ssh: false,
};

const release = (tag: string, name: string): Release => ({
  tag, name, body: null, draft: false, prerelease: false, webUrl: "https://example.com", createdAt: null, author: null,
});

describe("ReleasesView corrida ao trocar cwd", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.forgeReleases.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("a lista de A em voo não substitui B", async () => {
    const pendingA = deferred<Release[]>();
    const pendingB = deferred<Release[]>();
    mocks.forgeReleases.mockImplementation((cwd: string) => (
      cwd === "/repo-a" ? pendingA.promise : pendingB.promise
    ));

    await act(async () => {
      root.render(<ReleasesView cwd="/repo-a" target={target} />);
    });
    await act(async () => {
      root.render(<ReleasesView cwd="/repo-b" target={target} />);
    });

    await act(async () => {
      pendingB.resolve([release("v-b", "bravo")]);
      await Promise.resolve();
    });
    expect(host.textContent).toContain("v-b");
    expect(host.textContent).toContain("bravo");
    expect(host.textContent).not.toContain("v-a");
    expect(host.textContent).not.toContain("alfa");

    await act(async () => {
      pendingA.resolve([release("v-a", "alfa")]);
      await Promise.resolve();
    });
    expect(host.textContent).toContain("v-b");
    expect(host.textContent).toContain("bravo");
    expect(host.textContent).not.toContain("v-a");
    expect(host.textContent).not.toContain("alfa");
  });
});
