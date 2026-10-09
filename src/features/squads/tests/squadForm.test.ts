import { describe, expect, it } from "vitest";

import {
  addSquadRole,
  availableSquadRoles,
  EMPTY_SQUAD_INPUT,
  inputFromSquad,
  subagentDefaultIsReady,
  removeSquadRole,
} from "../squadForm";
import { assignmentIsUnavailable } from "../types";
import type { FunctionalRole, Squad } from "../types";

const roles: FunctionalRole[] = [
  { id: "backend", label: "Backend", description: "Server", instructions: "Implement server code" },
  { id: "frontend", label: "Frontend", description: "Client", instructions: "Implement UI" },
  { id: "qa", label: "QA", description: "Tests", instructions: "Verify changes" },
];

describe("Squad form", () => {
  it("adds and removes a role and prevents duplicate role assignment", () => {
    const withBackend = addSquadRole(EMPTY_SQUAD_INPUT, "backend");
    expect(withBackend.members).toHaveLength(1);
    expect(withBackend.members[0]).toMatchObject({ roleId: "backend", agentId: "", autoAccount: true, isolateDefault: true });
    expect(addSquadRole(withBackend, "backend")).toBe(withBackend);
    expect(availableSquadRoles(roles, withBackend.members).map((role) => role.id)).toEqual(["frontend", "qa"]);
    expect(removeSquadRole(withBackend, "backend").members).toEqual([]);
  });

  it("keeps unavailable saved provider and account IDs in the editable draft", () => {
    const squad: Squad = {
      id: "squad-1",
      name: "Saved Squad",
      description: "",
      lead: {
        agentId: "removed-lead-provider", model: "old-model", accountId: "deleted-lead-account",
        autoAccount: false, complexity: "hard", availability: "provider_missing", unavailableReason: "removed",
      },
      members: [{
        roleId: "backend", agentId: "removed-worker-provider", model: "saved-model", accountId: "deleted-account",
        autoAccount: false, complexity: null, isolateDefault: true, availability: "provider_missing", unavailableReason: "removed",
      }],
      createdAt: 1,
      updatedAt: 2,
      available: false,
      unavailableReasons: ["lead unavailable"],
    };
    const input = inputFromSquad(squad);
    expect(input.lead).toMatchObject({ agentId: "removed-lead-provider", accountId: "deleted-lead-account" });
    expect(input.members[0]).toMatchObject({ agentId: "removed-worker-provider", accountId: "deleted-account" });
    expect(input.lead).not.toHaveProperty("accountName");
  });

  it("treats unknown model availability as a runtime check, not a blocked assignment", () => {
    expect(assignmentIsUnavailable("available")).toBe(false);
    expect(assignmentIsUnavailable("unknown")).toBe(false);
    for (const status of ["provider_missing", "provider_not_installed", "provider_not_headless", "account_missing", "account_provider_mismatch"] as const) {
      expect(assignmentIsUnavailable(status)).toBe(true);
    }
  });

  it("round-trips Fast mode and defaults it to off for saved squads that predate it", () => {
    const squad = {
      id: "s", name: "S", description: "", createdAt: 0, updatedAt: 0, available: true, unavailableReasons: [],
      lead: { agentId: "codex", model: null, accountId: null, autoAccount: true, complexity: null, fastMode: true, availability: "available", unavailableReason: null },
      members: [{ roleId: "backend", agentId: "codex", model: null, accountId: null, autoAccount: true, complexity: null, isolateDefault: true, availability: "available", unavailableReason: null }],
    } as Squad;
    const draft = inputFromSquad(squad);
    expect(draft.lead.fastMode).toBe(true);
    expect(draft.members[0].fastMode).toBe(false);
  });

  it("starts with Automatic subagent and round-trips a saved default (Fast off when absent)", () => {
    expect(EMPTY_SQUAD_INPUT.defaultSubagent).toBeNull();
    const base = {
      id: "s", name: "S", description: "", createdAt: 0, updatedAt: 0, available: true, unavailableReasons: [], members: [],
      lead: { agentId: "codex", model: null, accountId: null, autoAccount: true, complexity: null, availability: "available", unavailableReason: null },
    };
    expect(inputFromSquad(base as Squad).defaultSubagent).toBeNull();
    const legacy = { ...base, defaultSubagent: { agentId: "codex", model: "gpt-6-luna" } } as Squad;
    expect(inputFromSquad(legacy).defaultSubagent).toEqual({ agentId: "codex", model: "gpt-6-luna", reasoningEffort: null, fastMode: false });
    const full = { ...base, defaultSubagent: { agentId: "codex", model: "gpt-6-luna", reasoningEffort: "max", fastMode: true } } as Squad;
    expect(inputFromSquad(full).defaultSubagent).toEqual({ agentId: "codex", model: "gpt-6-luna", reasoningEffort: "max", fastMode: true });
  });

  it("only blocks saving a subagent default that has no provider", () => {
    expect(subagentDefaultIsReady(null)).toBe(true);
    expect(subagentDefaultIsReady(undefined)).toBe(true);
    expect(subagentDefaultIsReady({ agentId: "codex", model: null })).toBe(true);
    expect(subagentDefaultIsReady({ agentId: "  ", model: null })).toBe(false);
    expect(subagentDefaultIsReady({ agentId: "codex", model: "" })).toBe(false);
  });
});
