import { describe, expect, it } from "vitest";

import { AGENTS_WITH_SKILL_SCAN, agentSlashInvocation, buildAgentSlashEntries } from "../agentSlashModel";

describe("comandos e skills do Codex no /", () => {
  it("o Codex entra na varredura e as skills dele são inseridas como $nome", () => {
    expect(AGENTS_WITH_SKILL_SCAN.has("codex")).toBe(true);
    expect(agentSlashInvocation({ name: "deploy" }, "codex")).toBe("$deploy ");
  });

  it("o Claude continua com /nome", () => {
    expect(agentSlashInvocation({ name: "deploy" }, "claude-code")).toBe("/deploy ");
  });

  it("skill que o skills/list do Codex anuncia entra como skill, mesmo sem a varredura do disco", () => {
    const entries = buildAgentSlashEntries({
      reported: [{ name: "deploy", description: "Publica", inputHint: null, kind: "skill" }],
      scanned: [],
      reservedNames: new Set(),
    });
    expect(entries).toEqual([
      { name: "deploy", description: "Publica", inputHint: null, plugin: null, scope: null, kind: "skill" },
    ]);
  });
});
