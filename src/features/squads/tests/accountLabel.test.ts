import { describe, expect, it } from "vitest";

import type { AgentAccount } from "@/features/accounts/types";

import { resolveSquadAccountLabel } from "../accountLabel";

const labels: Record<string, string> = {
  "accounts.auto": "Automatic",
  "accounts.system": "System account",
  "squads.accountUnavailable": "Unavailable account",
  "squads.accountLoading": "Loading account",
};
const translate = (key: string) => labels[key] ?? key;

const workAccount: AgentAccount = {
  id: "account-work",
  agentId: "codex",
  name: "Work",
  dir: "C:/profiles/work",
  envVar: "CODEX_HOME",
  loginCommand: "codex login",
  loggedIn: true,
  label: null,
  createdAt: 1,
};

describe("Squad account labels", () => {
  it("resolves labels from the current roster without persisting duplicate names", () => {
    expect(resolveSquadAccountLabel("account-work", false, [workAccount], true, translate)).toBe("Work");
    expect(resolveSquadAccountLabel(null, true, [workAccount], true, translate)).toBe("Automatic");
    expect(resolveSquadAccountLabel(null, false, [], true, translate)).toBe("System account");
  });

  it("keeps a removed account ID visible as unavailable after the roster loads", () => {
    expect(resolveSquadAccountLabel("removed-account-id", false, [], true, translate)).toBe("Unavailable account");
  });

  it("distinguishes a roster that is still loading", () => {
    expect(resolveSquadAccountLabel("saved-account-id", false, [], false, translate)).toBe("Loading account");
  });
});
