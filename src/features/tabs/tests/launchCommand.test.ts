import { beforeEach, describe, expect, it } from "vitest";

import { setAgentRegistry, type AgentRegistryEntry } from "@/features/agents/registry";
import { buildResumeCommand } from "@/features/sessions/agentResume";

import { buildLaunchCommand } from "../launchCommand";
import { useTabsStore } from "../store";
import type { AgentInfo, Tab } from "../types";

const SKIP = "--dangerously-skip-permissions";

function registryEntry(patch: Partial<AgentRegistryEntry> & Pick<AgentRegistryEntry, "id" | "command">): AgentRegistryEntry {
  return {
    label: patch.id,
    skillsDir: null,
    resume: null,
    supportsAccounts: false,
    sessions: "",
    mcp: "none",
    ...patch,
  };
}

function agent(patch: Partial<AgentInfo> & Pick<AgentInfo, "id" | "command">): AgentInfo {
  return { label: patch.id, available: true, ...patch };
}

beforeEach(() => {
  setAgentRegistry([]);
  useTabsStore.setState({ tabs: [], activeTabId: null, hydrated: false });
});

describe("buildLaunchCommand", () => {
  it("com launchArgs compõe o binário e a flag", () => {
    expect(buildLaunchCommand({ command: "agy", launchArgs: [SKIP] })).toBe(`agy ${SKIP}`);
  });

  it("sem launchArgs devolve o binário, sem espaço sobrando", () => {
    expect(buildLaunchCommand({ command: "agy" })).toBe("agy");
    expect(buildLaunchCommand({ command: "  agy  " })).toBe("agy");
  });

  it("não repete uma flag que o comando já traz", () => {
    expect(buildLaunchCommand({ command: `agy ${SKIP}`, launchArgs: [SKIP] })).toBe(`agy ${SKIP}`);
  });

  it("sem launchArgs no agente, usa o catálogo estático pelo id", () => {
    setAgentRegistry([
      registryEntry({ id: "antigravity", command: "agy", launchArgs: [SKIP] }),
      registryEntry({ id: "codex", command: "codex", launchArgs: [] }),
    ]);
    expect(buildLaunchCommand({ id: "antigravity", command: "agy" })).toBe(`agy ${SKIP}`);
    expect(buildLaunchCommand({ id: "codex", command: "codex" })).toBe("codex");
    expect(buildLaunchCommand({ id: "antigravity", command: `agy --mode accept-edits` })).toBe(
      `agy --mode accept-edits ${SKIP}`,
    );
  });
});

describe("buildResumeCommand sobre o comando composto", () => {
  beforeEach(() => {
    setAgentRegistry([
      registryEntry({ id: "antigravity", command: "agy", resume: null }),
      registryEntry({ id: "opencode", command: "opencode", resume: "--session {session}" }),
      registryEntry({ id: "claude-code", command: "claude", resume: "--resume {session}" }),
    ]);
  });

  it("mantém a flag e, se a TUI reanuda, acrescenta o id seguro depois", () => {
    const composed = buildLaunchCommand({ command: "agy", launchArgs: [SKIP] });
    expect(composed).toBe(`agy ${SKIP}`);
    // Antigravity não declara resume: a flag fica e o id não vira argumento.
    expect(buildResumeCommand("antigravity", composed, "sess-1")).toBe(composed);
    // Numa TUI que reanuda, a flag composta permanece e o id entra depois.
    expect(buildResumeCommand("opencode", composed, "ses_9f2A")).toBe(`${composed} --session ses_9f2A`);
  });

  it("um id inseguro não injeta flags e não apaga as de lançamento", () => {
    const composed = buildLaunchCommand({ command: "claude", launchArgs: [SKIP] });
    expect(buildResumeCommand("claude-code", composed, "x --dangerously-skip-permissions")).toBe(composed);
    expect(buildResumeCommand("claude-code", composed, "x & calc")).toBe(composed);
    expect(buildResumeCommand("claude-code", composed, "abc")).toBe(`${composed} --resume abc`);
  });
});

describe("addTab e hidratação", () => {
  beforeEach(() => {
    setAgentRegistry([
      registryEntry({ id: "antigravity", command: "agy", launchArgs: [SKIP] }),
      registryEntry({ id: "codex", command: "codex" }),
    ]);
  });

  it("o + compõe a flag no comando da tab e deixa os outros agentes pelados", () => {
    const agy = useTabsStore.getState().addTab({
      cwd: "/proj",
      agent: agent({ id: "antigravity", command: "agy", launchArgs: [SKIP] }),
    });
    const codex = useTabsStore.getState().addTab({
      cwd: "/proj",
      agent: agent({ id: "codex", command: "codex" }),
    });
    const tabs = useTabsStore.getState().tabs;
    expect(tabs.find((tab) => tab.id === agy)?.command).toBe(`agy ${SKIP}`);
    expect(tabs.find((tab) => tab.id === codex)?.command).toBe("codex");
  });

  it("restaurar uma janela antiga de agy acrescenta a flag sem duplicar", () => {
    const bare: Tab = {
      id: "velha",
      title: "Antigravity",
      cwd: "/proj",
      agentId: "antigravity",
      agentLabel: "Antigravity",
      command: "agy",
      ptyId: null,
      openedAt: 1,
    };
    const already: Tab = { ...bare, id: "nova", command: `agy ${SKIP}` };
    useTabsStore.getState().hydrateFromBackend([bare, already]);
    const tabs = useTabsStore.getState().tabs;
    expect(tabs.find((tab) => tab.id === "velha")?.command).toBe(`agy ${SKIP}`);
    expect(tabs.find((tab) => tab.id === "nova")?.command).toBe(`agy ${SKIP}`);
  });
});
