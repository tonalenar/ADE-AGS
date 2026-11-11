import { describe, expect, it } from "vitest";

import type { AgentSkillScan } from "@/features/skills/types";

import { agentSlashInvocation, buildAgentSlashEntries, searchAgentSlashEntries } from "../agentSlashModel";

// Skills que a varredura do disco acharia: uma de plugin, uma de projeto e uma pessoal.
const SCANNED: AgentSkillScan[] = [
  { name: "design:design-critique", description: "Feedback estruturado de usabilidade e hierarquia", plugin: "design", scope: "plugin" },
  { name: "deploy-app", description: "Publica o app no ambiente de homologação", plugin: null, scope: "project" },
  { name: "resumo-semanal", description: "Resume a semana a partir das notas", plugin: null, scope: "user" },
];

const NONE = new Set<string>();

describe("menu do / com as skills do agente", () => {
  it("ao digitar /desig aparece a skill de plugin mesmo sem o agente ter informado a lista", () => {
    const entries = buildAgentSlashEntries({ reported: [], scanned: SCANNED, reservedNames: NONE });

    const found = searchAgentSlashEntries(entries, "/desig");

    expect(found.map((entry) => entry.name)).toEqual(["design:design-critique"]);
    expect(found[0]).toMatchObject({ kind: "skill", plugin: "design", scope: "plugin" });
  });

  it("a skill de projeto entra pelo nome e pela descrição, sem acento", () => {
    const entries = buildAgentSlashEntries({ reported: [], scanned: SCANNED, reservedNames: NONE });

    expect(searchAgentSlashEntries(entries, "deploy").map((entry) => entry.name)).toEqual(["deploy-app"]);
    expect(searchAgentSlashEntries(entries, "homologacao").map((entry) => entry.name)).toEqual(["deploy-app"]);
    expect(searchAgentSlashEntries(entries, "deploy")[0]).toMatchObject({ scope: "project", plugin: null });
  });

  it("com o agente informado, a lista é a dele: skill que ele não anuncia fica de fora", () => {
    const reported = [
      { name: "design:design-critique", description: "Critica o design de uma tela", inputHint: "<arquivo>" },
      { name: "cost", description: "Mostra o custo da conversa", inputHint: null },
    ];

    const entries = buildAgentSlashEntries({ reported, scanned: SCANNED, reservedNames: NONE });

    expect(entries.map((entry) => entry.name).sort()).toEqual(["cost", "design:design-critique"]);
    expect(entries.find((entry) => entry.name === "design:design-critique")).toMatchObject({
      kind: "skill",
      scope: "plugin",
      plugin: "design",
      description: "Critica o design de uma tela",
      inputHint: "<arquivo>",
    });
    expect(entries.find((entry) => entry.name === "cost")).toMatchObject({ kind: "command", scope: null, plugin: null });
  });

  it("nome reservado pelo ADE (comando nativo ou skill já anexada) não aparece duplicado", () => {
    const reported = [{ name: "compact", description: "Compacta a conversa", inputHint: null }];

    const withCommand = buildAgentSlashEntries({ reported, scanned: [], reservedNames: new Set(["compact"]) });
    const withSkill = buildAgentSlashEntries({ reported: [], scanned: SCANNED, reservedNames: new Set(["deploy-app"]) });

    expect(withCommand).toEqual([]);
    expect(withSkill.map((entry) => entry.name)).not.toContain("deploy-app");
  });

  it("o mesmo nome em caixa diferente aparece uma vez só", () => {
    const reported = [
      { name: "Cost", description: "Mostra o custo", inputHint: null },
      { name: "cost", description: "Mostra o custo", inputHint: null },
    ];

    const entries = buildAgentSlashEntries({ reported, scanned: [], reservedNames: NONE });

    expect(entries.map((entry) => entry.name)).toEqual(["Cost"]);
  });

  it("nome que começa com o texto digitado vem antes do que só casa na descrição", () => {
    const entries = buildAgentSlashEntries({
      reported: [],
      scanned: [...SCANNED, { name: "revisar-ux", description: "Review the design of screens", plugin: null, scope: "user" }],
      reservedNames: NONE,
    });

    expect(searchAgentSlashEntries(entries, "design").map((entry) => entry.name)).toEqual([
      "design:design-critique",
      "revisar-ux",
    ]);
  });

  it("escolher a entrada insere a barra, o nome completo e um espaço, como o Claude espera", () => {
    const [entry] = searchAgentSlashEntries(buildAgentSlashEntries({ reported: [], scanned: SCANNED, reservedNames: NONE }), "desig");

    expect(agentSlashInvocation(entry!)).toBe("/design:design-critique ");
  });

  it("entrada sem descrição continua encontrável pelo nome", () => {
    const entries = buildAgentSlashEntries({
      reported: [{ name: "agent-tools", description: "", inputHint: null }],
      scanned: [],
      reservedNames: NONE,
    });

    expect(searchAgentSlashEntries(entries, "agent")).toHaveLength(1);
    expect(entries[0]?.description).toBe("");
  });
});
