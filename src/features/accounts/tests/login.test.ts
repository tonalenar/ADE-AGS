import { describe, expect, it, vi } from "vitest";
import { accountLoginCommand, accountLoginEnv } from "../login";
import type { AgentAccount } from "../types";

describe("account login isolation", () => {
  it("logs into the main account without looking up a synthetic database ID", async () => {
    const envFor = vi.fn().mockRejectedValue(new Error("Account not found"));
    expect(await accountLoginEnv("system:claude-code", envFor)).toEqual({});
    expect(envFor).not.toHaveBeenCalled();
  });

  it("retains the chosen profile and fails instead of silently using the main account", async () => {
    const envFor = vi.fn().mockResolvedValue({ CLAUDE_CONFIG_DIR: "C:/accounts/work" });
    expect(await accountLoginEnv("work-id", envFor)).toEqual({ CLAUDE_CONFIG_DIR: "C:/accounts/work" });
    expect(envFor).toHaveBeenCalledWith("work-id");
    envFor.mockRejectedValue(new Error("Account deleted"));
    await expect(accountLoginEnv("work-id", envFor)).rejects.toThrow("Account deleted");
  });

  it("starts Claude's login flow instead of a conversation", () => {
    expect(accountLoginCommand({ agentId: "claude-code", loginCommand: "claude" } as AgentAccount))
      .toBe("claude auth login --claudeai");
    expect(accountLoginCommand({ agentId: "codex", loginCommand: "codex login" } as AgentAccount))
      .toBe("codex login");
  });
});
