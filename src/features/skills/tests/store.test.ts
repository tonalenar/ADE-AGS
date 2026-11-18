import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  listSkills: vi.fn(),
}));

vi.mock("../ipc", () => ipc);

import { useSkillsStore } from "../store";

describe("useSkillsStore.loadSkills", () => {
  beforeEach(() => {
    useSkillsStore.setState({ skills: [], loading: false, error: null, skillsDir: "", brokenSymlinks: [] });
    ipc.listSkills.mockReset();
  });

  it("grava o erro da listagem em vez de engolir a rejeição", async () => {
    ipc.listSkills.mockRejectedValueOnce(new Error("rede"));
    await useSkillsStore.getState().loadSkills();
    expect(useSkillsStore.getState().error).toContain("rede");
    expect(useSkillsStore.getState().loading).toBe(false);
  });
});
