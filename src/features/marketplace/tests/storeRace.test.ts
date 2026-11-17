import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  listRegistries: vi.fn(async () => []),
  listMarketplaceSkills: vi.fn(),
  searchRemoteRegistries: vi.fn(async () => undefined),
  addRegistry: vi.fn(),
  renameRegistry: vi.fn(),
  removeRegistry: vi.fn(),
  registrySkills: vi.fn(),
  setRegistryEnabled: vi.fn(),
  refreshRegistry: vi.fn(),
  installMarketplaceSkill: vi.fn(),
}));

vi.mock("../ipc", () => ipc);

import { useMarketplaceStore } from "../store";
import type { MarketplaceSkillEntry } from "../types";

const skill = (id: string): MarketplaceSkillEntry => ({
  id,
  registryId: "r",
  registryName: "repo",
  name: id,
  author: null,
  description: null,
  categories: [],
  compatibleAgents: [],
  folderPath: id,
  files: ["SKILL.md"],
  installs: null,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}

describe("marketplace loadSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMarketplaceStore.setState({
      registries: [{
        id: "r", name: "skills.sh", sourceType: "skillssh", location: "", enabled: true,
        skillCount: 0, lastFetched: null, error: null, priority: 0,
      }],
      skills: [],
      loading: false,
      searchingRemote: false,
      refreshingId: null,
      installingKey: null,
    });
  });

  it("descarta a lista da busca anterior", async () => {
    const first = deferred<MarketplaceSkillEntry[]>();
    const second = deferred<MarketplaceSkillEntry[]>();
    ipc.listMarketplaceSkills
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const a = useMarketplaceStore.getState().loadSkills("abc");
    const b = useMarketplaceStore.getState().loadSkills("abcd");

    first.resolve([skill("old")]);
    await a;
    expect(useMarketplaceStore.getState().skills.map((row) => row.id)).toEqual([]);

    second.resolve([skill("new")]);
    await b;
    expect(useMarketplaceStore.getState().skills.map((row) => row.id)).toEqual(["new"]);
  });
});
