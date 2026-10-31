import { describe, expect, it } from "vitest";

import cases from "@/features/chat/permissions/fixtures/permission-cases.json";
import security from "@/features/chat/permissions/fixtures/permission-security.json";
import { commandParts, insideFolder, isNetworkCommand, riskOf, ruleMatches, type AskKind } from "@/features/chat/permissions/permissionModel";
import { decidePermission, type PermissionKind } from "@/features/chat/team/teamPermissions";
import type { TeamPolicy } from "@/features/chat/team/ipc";

/**
 * As fixtures são compartilhadas com o backend (`src-tauri/src/chat_team/permission.rs`): o `cargo test` lê o
 * mesmo arquivo. O TypeScript é a referência; se um lado muda, o outro tem que acompanhar.
 */
describe("fixtures compartilhadas com o backend", () => {
  it("risco", () => {
    for (const c of cases.risk) {
      expect(riskOf({ kind: c.kind as AskKind, detail: c.detail, files: c.files, cwd: c.cwd }), JSON.stringify(c)).toBe(c.expected);
    }
  });

  it("casamento de regra", () => {
    for (const c of cases.match) {
      const rule = { id: "r", createdAt: 0, ...c.rule, kind: c.rule.kind as AskKind };
      expect(ruleMatches(rule, { ...c.ask, kind: c.ask.kind as AskKind }), JSON.stringify(c)).toBe(c.expected);
    }
  });

  it("política do time", () => {
    for (const c of cases.decide) expect(decidePermission(c.policy as TeamPolicy, c.kind as PermissionKind, c.highRisk), JSON.stringify(c)).toBe(c.expected);
  });

  it("rede, partes do comando e pasta", () => {
    for (const c of cases.network) expect(isNetworkCommand(c.command), c.command).toBe(c.expected);
    for (const c of cases.parts) expect(commandParts(c.command), c.command).toEqual(c.expected);
    for (const c of cases.inside) expect(insideFolder(c.file, c.cwd), JSON.stringify(c)).toBe(c.expected);
  });

  it("as fixtures cobrem o que importa: comando multilinha e com substituição não casam regra", () => {
    const multi = cases.match.find((c) => c.ask.detail === "bun add zod\nrm -rf ~" && c.rule.pattern === "bun add *");
    const subst = cases.match.find((c) => c.ask.detail === "bun add $(whoami)" && c.rule.pattern === "bun add *");
    expect([multi?.expected, subst?.expected]).toEqual([false, false]);
  });
});

/**
 * Os casos de SEGURANÇA são escritos à mão (`permission-security.json`): o esperado é a regra, não o que o código
 * faz, e o arquivo nunca é regenerado. Na dúvida, falha fechado (nunca «dentro da pasta», nunca «só leitura»).
 */
describe("casos de segurança (escritos à mão)", () => {
  it("pasta: `..`, `~`, variáveis, barras e Windows", () => {
    for (const c of security.inside) expect(insideFolder(c.file, c.cwd), JSON.stringify(c)).toBe(c.expected);
  });

  it("risco", () => {
    for (const c of security.risk) {
      expect(riskOf({ kind: c.kind as AskKind, detail: c.detail, files: c.files, cwd: c.cwd }), JSON.stringify(c)).toBe(c.expected);
    }
  });

  it("casamento de regra", () => {
    for (const c of security.match) {
      const rule = { id: "r", createdAt: 0, ...c.rule, kind: c.rule.kind as AskKind };
      expect(ruleMatches(rule, { ...c.ask, kind: c.ask.kind as AskKind }), JSON.stringify(c)).toBe(c.expected);
    }
  });
});
