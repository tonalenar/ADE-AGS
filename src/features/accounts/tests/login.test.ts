import { describe, expect, it } from "vitest";
import { accountLoginAccountId, accountLoginCommand } from "../login";
import type { AgentAccount } from "../types";

describe("account login isolation", () => {
  it("sends only a real account id; the system account has no database row", () => {
    expect(accountLoginAccountId("system:claude-code")).toBeUndefined();
    expect(accountLoginAccountId("work-id")).toBe("work-id");
  });

  it("starts Claude's login flow instead of a conversation", () => {
    expect(accountLoginCommand({ agentId: "claude-code", loginCommand: "claude" } as AgentAccount))
      .toBe("claude auth login --claudeai");
    expect(accountLoginCommand({ agentId: "codex", loginCommand: "codex login" } as AgentAccount))
      .toBe("codex login");
  });
});
