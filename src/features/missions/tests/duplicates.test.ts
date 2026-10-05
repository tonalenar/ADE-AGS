import { describe, expect, it } from "vitest";
import { findDuplicateMission, normalizeText, RECENT_MISSION_SECS } from "../duplicates";
import type { MissionSummary } from "../types";

function mockMission(overrides: Partial<MissionSummary> = {}): MissionSummary {
  return {
    id: "m-1",
    workspaceId: "w-1",
    title: "Refatorar autenticação",
    objective: "Migrar para tokens JWT com rotação",
    cwd: "C:/projects/app",
    status: "draft",
    maxParallel: 2,
    budgetUsd: null,
    leadAgentId: null,
    leadModel: null,
    leadAccountId: null,
    autoAccount: true,
    complexity: null,
    activeRunId: null,
    createdAt: 1000,
    updatedAt: 1000,
    startedAt: null,
    endedAt: null,
    spentUsd: 0,
    workersTotal: 0,
    workersDone: 0,
    leadAgent: null,
    leadStatus: null,
    activeSeconds: null,
    activeSource: null,
    ...overrides,
  };
}

describe("normalizeText", () => {
  it("normaliza espaços em branco e capitalização", () => {
    expect(normalizeText("  Refatorar   Autenticação\n\t")).toBe("refatorar autenticação");
  });
});

describe("findDuplicateMission", () => {
  const now = 100_000;

  it("detecta missão idêntica em andamento (running)", () => {
    const running = mockMission({
      id: "m-running",
      title: "  Refatorar Autenticação ",
      objective: "Migrar para tokens JWT com rotação",
      status: "running",
      createdAt: now - 3600 * 48, // criada há 2 dias, mas ainda rodando
    });

    const result = findDuplicateMission(
      [running],
      { title: "refatorar autenticação", objective: "migrar para tokens jwt com rotação" },
      now
    );

    expect(result).not.toBeNull();
    expect(result?.mission.id).toBe("m-running");
    expect(result?.isRunning).toBe(true);
  });

  it("detecta missão idêntica recente mesmo que finalizada ou cancelada", () => {
    const recent = mockMission({
      id: "m-recent",
      title: "Refatorar Autenticação",
      objective: "Migrar para tokens JWT com rotação",
      status: "cancelled",
      createdAt: now - 3600, // criada há 1 hora
    });

    const result = findDuplicateMission(
      [recent],
      { title: "Refatorar Autenticação", objective: "Migrar para tokens JWT com rotação" },
      now
    );

    expect(result).not.toBeNull();
    expect(result?.mission.id).toBe("m-recent");
    expect(result?.isRunning).toBe(false);
    expect(result?.isRecent).toBe(true);
  });

  it("ignora a própria missão ao comparar por ID", () => {
    const existing = mockMission({
      id: "m-same",
      title: "Refatorar Autenticação",
      objective: "Migrar para tokens JWT com rotação",
      status: "running",
      createdAt: now - 100,
    });

    const result = findDuplicateMission(
      [existing],
      { id: "m-same", title: "Refatorar Autenticação", objective: "Migrar para tokens JWT com rotação" },
      now
    );

    expect(result).toBeNull();
  });

  it("não detecta quando títulos ou objetivos são diferentes", () => {
    const existing = mockMission({
      id: "m-diff",
      title: "Refatorar Banco de Dados",
      objective: "Migrar para SQLite",
      status: "running",
      createdAt: now - 100,
    });

    const result = findDuplicateMission(
      [existing],
      { title: "Refatorar Autenticação", objective: "Migrar para tokens JWT com rotação" },
      now
    );

    expect(result).toBeNull();
  });

  it("não detecta se a missão for antiga (> 24h) e não estiver em andamento", () => {
    const old = mockMission({
      id: "m-old",
      title: "Refatorar Autenticação",
      objective: "Migrar para tokens JWT com rotação",
      status: "done",
      createdAt: now - (RECENT_MISSION_SECS + 500),
      startedAt: now - (RECENT_MISSION_SECS + 400),
    });

    const result = findDuplicateMission(
      [old],
      { title: "Refatorar Autenticação", objective: "Migrar para tokens JWT com rotação" },
      now
    );

    expect(result).toBeNull();
  });
});
