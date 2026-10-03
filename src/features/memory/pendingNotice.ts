import type { MemoryEntry, MemoryPendingCounts } from "./types";

export const pendingKeyOf = (entry: MemoryEntry): string => `${entry.id}:${entry.pendingRevision}`;

export const totalPending = (counts: MemoryPendingCounts): number =>
  counts.workspace + Object.values(counts.byMission).reduce((total, count) => total + count, 0);

export const grownOwners = (prev: MemoryPendingCounts, next: MemoryPendingCounts): (string | null)[] => {
  const owners: (string | null)[] = [];
  if (next.workspace > prev.workspace) owners.push(null);
  for (const [missionId, count] of Object.entries(next.byMission)) {
    if (count > (prev.byMission[missionId] ?? 0)) owners.push(missionId);
  }
  return owners;
};

export const newAgentProposals = (entries: MemoryEntry[], seen: ReadonlySet<string>): MemoryEntry[] =>
  entries.filter((entry) =>
    entry.pendingRevision !== null &&
    entry.pendingActorKind !== null &&
    entry.pendingActorKind !== "user" &&
    !seen.has(pendingKeyOf(entry))
  );

export const suggesterName = (entry: MemoryEntry): string => {
  const match = entry.pendingReason?.match(/^Proposta de (.+?) na missão/);
  if (match) return match[1];
  return entry.pendingActorKind === "lead" ? "Lead" : "Agente";
};
