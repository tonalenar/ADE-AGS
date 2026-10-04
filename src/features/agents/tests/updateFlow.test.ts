import { describe, expect, it, vi } from "vitest";

import { updateAgentRestarting, type UpdateFlowDeps } from "../updateFlow";
import type { AgentUpdateInfo, AgentUpdateResult } from "../updatePolicy";

const info = (patch: Partial<AgentUpdateInfo> = {}): AgentUpdateInfo => ({
  agentId: "codex", label: "Codex", currentVersion: "0.159.3", latestVersion: "0.160.0",
  updateAvailable: true, canAutoUpdate: false, busy: true, reason: "busy_terminal", ...patch,
});
const ok: AgentUpdateResult = { agentId: "codex", ok: true, output: "", newVersion: "0.160.0", error: null };

/** Un mundo falso: `ptys` = pestaña → pid; `kill` lo borra (o no, para probar el que no muere). */
function world(options: { ptys?: Record<string, number>; infos?: AgentUpdateInfo[]; immortal?: string[]; update?: AgentUpdateResult } = {}) {
  const ptys = { ...(options.ptys ?? { t1: 11, t2: 12 }) };
  const calls: string[] = [];
  const deps: UpdateFlowDeps = {
    tabs: () => [
      { id: "t1", agentId: "codex" }, { id: "t2", agentId: "codex" }, { id: "t3", agentId: "claude-code" },
    ],
    ptyForTab: async (id) => ptys[id] ?? null,
    ptyKill: async (pid) => {
      calls.push(`kill:${pid}`);
      for (const [tab, p] of Object.entries(ptys)) if (p === pid && !options.immortal?.includes(tab)) delete ptys[tab];
    },
    restartAgent: (id) => calls.push(`restart:${id}`),
    check: async () => options.infos ?? [info()],
    update: vi.fn(async (_id: string, released: boolean) => {
      calls.push(`update:${released}`);
      return options.update ?? ok;
    }),
    sleep: async () => {},
  };
  return { deps, calls };
}

describe("updateAgentRestarting", () => {
  it("fecha las terminales del agente, actualiza liberando y las vuelve a abrir (solo las de ese agente)", async () => {
    const { deps, calls } = world();
    const out = await updateAgentRestarting("codex", deps);
    expect(out.result.ok).toBe(true);
    expect(out.reopened).toBe(2);
    // Cierra, actualiza ya con los terminales liberados y recién después relanza; la de claude no se toca.
    expect(calls).toEqual(["kill:11", "kill:12", "update:true", "restart:t1", "restart:t2"]);
  });

  it("si el agente está en una misión en curso no cierra NADA", async () => {
    const { deps, calls } = world({ infos: [info({ reason: "busy_mission" })] });
    const out = await updateAgentRestarting("codex", deps);
    expect(out.result).toMatchObject({ ok: false, error: "busy_mission" });
    expect(out.reopened).toBe(0);
    expect(calls).toEqual([]);
  });

  it("tampoco cierra nada si el agente no se puede actualizar por otra razón", async () => {
    for (const reason of ["not_npm", "no_updater", "check_failed"]) {
      const { deps, calls } = world({ infos: [info({ reason })] });
      const out = await updateAgentRestarting("codex", deps);
      expect(out.result.error).toBe(reason);
      expect(calls).toEqual([]);
    }
  });

  it("si un proceso no muere no actualiza, pero igual relanza lo que cerró", async () => {
    const { deps, calls } = world({ immortal: ["t2"] });
    const out = await updateAgentRestarting("codex", deps);
    expect(out.result).toMatchObject({ ok: false, error: "busy_terminal" });
    expect(calls).not.toContain("update:true");
    expect(calls).toEqual(expect.arrayContaining(["restart:t1", "restart:t2"]));
  });

  it("si la actualización falla, las pestañas se relanzan igual", async () => {
    const failed: AgentUpdateResult = { ...ok, ok: false, newVersion: null, error: "failed" };
    const { deps, calls } = world({ update: failed });
    const out = await updateAgentRestarting("codex", deps);
    expect(out.result.ok).toBe(false);
    expect(calls.filter((c) => c.startsWith("restart:"))).toEqual(["restart:t1", "restart:t2"]);
  });

  it("si la actualización lanza un error, se relanza y se devuelve un fallo", async () => {
    const { deps, calls } = world();
    deps.update = vi.fn(async () => { throw new Error("boom"); });
    const out = await updateAgentRestarting("codex", deps);
    expect(out.result).toMatchObject({ ok: false, error: "failed" });
    expect(calls.filter((c) => c.startsWith("restart:"))).toHaveLength(2);
  });

  it("sin terminales abiertas del agente actualiza igual y no relanza nada", async () => {
    const { deps, calls } = world({ ptys: {}, infos: [info({ reason: null, canAutoUpdate: true, busy: false })] });
    const out = await updateAgentRestarting("codex", deps);
    expect(out.result.ok).toBe(true);
    expect(out.reopened).toBe(0);
    expect(calls).toEqual(["update:true"]);
  });

  it("un agente desconocido no hace nada", async () => {
    const { deps, calls } = world({ infos: [] });
    const out = await updateAgentRestarting("codex", deps);
    expect(out.result.error).toBe("no_updater");
    expect(calls).toEqual([]);
  });
});
