import { describe, expect, it } from "vitest";

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import ptBR from "@/i18n/locales/pt-BR.json";
import type { TeamView } from "../ipc";
import { decidePermission, teamPolicyOf, teamRequester, teamVerdict, teamVerdictForAsk } from "../teamPermissions";

const TEAM: TeamView = {
  id: "t1", orchestrator: "lead", agentId: "claude-code", label: "Claude Code", cwd: "/r", title: "", createdAt: 1, updatedAt: 1, headcount: 2,
  members: [{ teamId: "t1", member: "thread:k", agentId: "kimi", label: "Kimi", role: "qa", model: null, policy: "read", branch: null, worktree: null, origin: "new", position: 0, createdAt: 1, updatedAt: 1 }],
};

describe("a política do time na caixa de Permissões", () => {
  it("decide sozinha só o que pode, e risco alto nunca é automático", () => {
    expect(decidePermission("read", "read", true)).toBe("allow");
    expect(decidePermission("read", "edit", false)).toBe("deny");
    expect(decidePermission("ask", "edit", false)).toBe("ask");
    expect(decidePermission("edits", "edit", false)).toBe("allow");
    expect(decidePermission("edits", "network", false)).toBe("ask");
    expect(decidePermission("full", "command", false)).toBe("allow");
    expect(decidePermission("full", "command", true)).toBe("ask");
  });

  it("diz de quem é o pedido: papel, política e time", () => {
    expect(teamRequester([TEAM], "thread:k")).toEqual({ teamId: "t1", orchestrator: "lead", role: "qa", policy: "read", label: "Kimi" });
    expect(teamRequester([TEAM], "lead")?.role).toBe("orchestrator");
    expect(teamPolicyOf([TEAM], "lead")).toBeNull();
    expect(teamVerdict([TEAM], "thread:k", "edit", false)).toBe("deny");
    expect(teamVerdict([TEAM], "fora", "edit", false)).toBeNull();
  });

  it("lê o pedido da caixa pelo formato: comando com rede conta como rede", () => {
    const edits: TeamView = { ...TEAM, members: [{ ...TEAM.members[0]!, policy: "edits" }] };
    const ask = { conversation: "thread:k", kind: "edit" as const, network: false, risk: "low" as const };
    expect(teamVerdictForAsk([edits], ask)).toBe("allow");
    expect(teamVerdictForAsk([edits], { ...ask, risk: "high" })).toBe("ask");
    expect(teamVerdictForAsk([{ ...edits, members: [{ ...edits.members[0]!, policy: "full" }] }], { ...ask, kind: "command", network: true, risk: "medium" })).toBe("allow");
    expect(teamVerdictForAsk([TEAM], { ...ask, kind: "command", network: true })).toBe("deny");
    expect(teamVerdictForAsk([TEAM], { ...ask, conversation: null })).toBeNull();
  });
});

describe("as chaves de i18n do time", () => {
  it("toda chave fixa que o time usa existe no catálogo", () => {
    const dir = join(__dirname, "..");
    const source = readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    const used = [...source.matchAll(/(?:t\(|i18nKey=)"(chat\.(?:team|panel)\.[\w.]+)"/g)].map((m) => m[1]!);
    const catalog = ptBR as Record<string, string>;
    const missing = [...new Set(used)].filter((k) => !(k in catalog) && !(`${k}_one` in catalog));
    expect(used.length).toBeGreaterThan(20);
    expect(missing).toEqual([]);
    for (const group of ["roles", "policy", "policyMenu", "state"]) {
      expect(Object.keys(catalog).some((k) => k.startsWith(`chat.team.${group}.`)), group).toBe(true);
    }
  });
});
