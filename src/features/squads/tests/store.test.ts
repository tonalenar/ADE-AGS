import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  listSquads: vi.fn(),
  listFunctionalRoles: vi.fn(),
  createSquad: vi.fn(),
  updateSquad: vi.fn(),
  deleteSquad: vi.fn(),
}));

vi.mock("../ipc", () => ipc);

import { useSquadsStore } from "../store";
import type { Squad, SquadInput } from "../types";

const saved: Squad = {
  id: "squad-1",
  name: "Persistent Squad",
  description: "Saved locally",
  lead: {
    agentId: "opencode", model: "big-pickle", accountId: null, autoAccount: true,
    complexity: "hard", availability: "unknown", unavailableReason: null,
  },
  members: [],
  createdAt: 1,
  updatedAt: 1,
  available: true,
  unavailableReasons: [],
};

const input: SquadInput = {
  name: saved.name,
  description: saved.description,
  lead: { agentId: "opencode", model: "big-pickle", accountId: null, autoAccount: true, complexity: "hard" },
  members: [],
};

describe("Squads store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSquadsStore.setState({ squads: [], roles: [], loaded: false });
  });

  it("rehydrates the saved Squad list on reload", async () => {
    ipc.listSquads.mockResolvedValue([saved]);
    await useSquadsStore.getState().load();
    expect(useSquadsStore.getState()).toMatchObject({ squads: [saved], loaded: true });
  });

  it("refreshes the persisted list after create, update, and delete", async () => {
    const updated = { ...saved, name: "Updated Squad", updatedAt: 2 };
    ipc.createSquad.mockResolvedValue(saved);
    ipc.updateSquad.mockResolvedValue(updated);
    ipc.deleteSquad.mockResolvedValue(undefined);
    ipc.listSquads.mockResolvedValueOnce([saved]).mockResolvedValueOnce([updated]).mockResolvedValueOnce([]);

    await useSquadsStore.getState().create(input);
    expect(useSquadsStore.getState().squads).toEqual([saved]);
    await useSquadsStore.getState().update(saved.id, { ...input, name: updated.name });
    expect(useSquadsStore.getState().squads).toEqual([updated]);
    await useSquadsStore.getState().remove(saved.id);
    expect(useSquadsStore.getState().squads).toEqual([]);
    expect(ipc.deleteSquad).toHaveBeenCalledWith(saved.id);
  });
});
