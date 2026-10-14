import { describe, expect, it, vi } from "vitest";

import { branchChips, browserUrl, repoStatus } from "../repoPanel";
import type { GitAccount, RepoTarget } from "../types";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn(), revealItemInDir: vi.fn() }));

const account = { id: "a1", kind: "github", host: "github.com", login: "luis" } as GitAccount;
const target = { account, accounts: [account] } as unknown as RepoTarget;

describe("branchChips", () => {
  it("muestra hasta dos ramas y cuenta el resto", () => {
    expect(branchChips(["main", "feat/a", "fix/b", "x"])).toEqual({ shown: ["main", "feat/a"], more: 2 });
  });
  it("sin sobrantes no marca ninguna", () => {
    expect(branchChips(["main"])).toEqual({ shown: ["main"], more: 0 });
    expect(branchChips([])).toEqual({ shown: [], more: 0 });
  });
});

describe("browserUrl", () => {
  it("convierte un remoto https en la página del repo", () => {
    expect(browserUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r");
    expect(browserUrl("https://gitlab.com/grupo/sub/r/")).toBe("https://gitlab.com/grupo/sub/r");
  });
  it("no ofrece enlace para ssh, sin remoto ni URL con credenciales", () => {
    expect(browserUrl("git@github.com:o/r.git")).toBeNull();
    expect(browserUrl("ssh://git@github.com/o/r.git")).toBeNull();
    expect(browserUrl("")).toBeNull();
    expect(browserUrl("https://user:token@github.com/o/r.git")).toBeNull();
    expect(browserUrl("http://github.com/o/r")).toBeNull();
  });
});

describe("repoStatus", () => {
  it("distingue cargando, sin remoto, conectado y sin conta", () => {
    expect(repoStatus(undefined)).toBe("loading");
    expect(repoStatus(null)).toBe("noRemote");
    expect(repoStatus(target)).toBe("connected");
    expect(repoStatus({ ...target, account: null } as RepoTarget)).toBe("disconnected");
  });
});
