import { describe, expect, it } from "vitest";
import {
  grownOwners,
  newAgentProposals,
  pendingKeyOf,
  suggesterName,
  totalPending,
} from "../pendingNotice";
import type { MemoryEntry } from "../types";

const entry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry =>
  ({
    id: "entry-1",
    pendingRevision: 1,
    pendingActorKind: "worker",
    pendingReason: null,
    ...overrides,
  }) as MemoryEntry;

describe("memory pending notice helpers", () => {
  it("builds a stable key from entry id and pending revision", () => {
    expect(pendingKeyOf(entry({ id: "entry-7", pendingRevision: 3 }))).toBe("entry-7:3");
  });

  it("sums workspace and mission pending counts", () => {
    expect(totalPending({ workspace: 2, byMission: { m1: 3, m2: 4 } })).toBe(9);
  });

  it("reports owners whose counts grew, including the workspace", () => {
    const previous = { workspace: 1, byMission: { m1: 2, m2: 3, m3: 1 } };
    const next = { workspace: 2, byMission: { m1: 2, m2: 1, m3: 4, m4: 1 } };

    expect(grownOwners(previous, next)).toEqual([null, "m3", "m4"]);
  });

  it("keeps only unseen new lead and worker proposals", () => {
    const alreadySeen = entry({ id: "seen", pendingRevision: 2, pendingActorKind: "lead" });
    const proposals = [
      entry({ id: "not-pending", pendingRevision: null }),
      entry({ id: "user-proposal", pendingActorKind: "user" }),
      alreadySeen,
      entry({ id: "new-lead", pendingActorKind: "lead" }),
      entry({ id: "new-worker", pendingActorKind: "worker" }),
    ];
    const seen = new Set([pendingKeyOf(alreadySeen)]);

    expect(newAgentProposals(proposals, seen).map(({ id }) => id)).toEqual([
      "new-lead",
      "new-worker",
    ]);
  });

  it("extracts the suggester from a proposal reason and falls back by actor", () => {
    expect(
      suggesterName(
        entry({
          pendingActorKind: "worker",
          pendingReason: "Proposta de Backend na missão abc12345",
        }),
      ),
    ).toBe("Backend");
    expect(suggesterName(entry({ pendingActorKind: "lead", pendingReason: "another format" }))).toBe(
      "Lead",
    );
    expect(suggesterName(entry({ pendingActorKind: "worker", pendingReason: null }))).toBe(
      "Agente",
    );
  });
});
