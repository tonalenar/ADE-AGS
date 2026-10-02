import { describe, expect, it } from "vitest";

import { modelIsUnverified, modelSelectionMode, modelSelectionPatch, modelsForAccount } from "../modelSelection";
import { reasoningOptions, withModelEffort } from "../modelSelection";

describe("Squad model selection", () => {
  it("recalculates effort by model without modifying provider/account fields", () => {
    const catalog = [{ id: "luna", reasoningLevels: ["low", "medium", "high", "xhigh"] }, { id: "small", reasoningLevels: ["low"] }];
    expect(reasoningOptions("luna", catalog)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(withModelEffort({ model: "luna", complexity: null }, "high", catalog).reasoningEffort).toBe("high");
    expect(withModelEffort({ model: "small", complexity: null }, "high", catalog).reasoningEffort).toBeNull();
    expect(withModelEffort({ model: null, complexity: "hard" }, "high", catalog).reasoningEffort).toBeNull();
    expect(reasoningOptions("custom-model", catalog)).toEqual([]);
  });
  it("keeps provider default distinct from complexity routing and a saved model", () => {
    expect(modelSelectionMode(null, null)).toBe("provider-default");
    expect(modelSelectionMode(null, "hard")).toBe("complexity");
    expect(modelSelectionMode("gpt-6-luna", null)).toBe("specific");
    expect(modelSelectionPatch("provider-default", "gpt-6-luna", "hard")).toEqual({ model: null, complexity: null });
    expect(modelSelectionPatch("complexity", "gpt-6-luna", null)).toEqual({ model: null, complexity: "standard" });
    expect(modelSelectionPatch("specific", null, "hard")).toEqual({ model: "", complexity: null });
  });

  it("uses the selected account catalog without mixing profiles", () => {
    const accountModels = [{ id: "private-model" }];
    const agent = {
      models: [{ id: "system-model" }],
      accounts: [{ accountId: "account-a", models: accountModels }, { accountId: "account-b", models: [{ id: "other-model" }] }],
    };
    expect(modelsForAccount(agent, "account-a", false)).toBe(accountModels);
    expect(modelsForAccount(agent, "account-b", false)).toEqual([{ id: "other-model" }]);
    expect(modelsForAccount(agent, null, true)).toEqual([{ id: "system-model" }]);
  });

  it("preserves manual IDs and marks IDs absent from the selected catalog as unverified", () => {
    expect(modelIsUnverified("gpt-future", [{ id: "gpt-6-luna" }])).toBe(true);
    expect(modelIsUnverified("gpt-6-luna", [{ id: "gpt-6-luna" }])).toBe(false);
    expect(modelIsUnverified(null, [])).toBe(false);
  });

  it("keeps historical and manual Claude IDs specific and unverified", () => {
    const catalog = [{ id: "old/custom", source: "ade_history" }, { id: "sonnet", source: "claude_cli_help" }];
    expect(modelSelectionMode("old/custom", null)).toBe("specific");
    expect(modelSelectionPatch("specific", "old/custom", null)).toEqual({ model: "old/custom", complexity: null });
    expect(modelIsUnverified("old/custom", catalog)).toBe(true);
    expect(modelIsUnverified("future/custom", catalog)).toBe(true);
    expect(modelIsUnverified("sonnet", catalog)).toBe(false);
  });
});
