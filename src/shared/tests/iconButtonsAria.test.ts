import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Botões só de ícone precisam de rótulo acessível: o Tooltip sozinho não nomeia o botão
// para leitores de tela.
const CASOS: Array<[string, RegExp]> = [
  ["src/app/SideHead.tsx", /<Button variant="icon" aria-label=\{workspacesCollapsed \? t\("panel\.expand"\)/],
  ["src/features/missions/MissionsSection.tsx", /<Button variant="icon" aria-label=\{t\("missions\.new"\)\}/],
  ["src/features/workspaces/WorkspacesPanel.tsx", /<Button variant="icon" aria-label=\{t\("workspaces\.new"\)\}/],
  ["src/features/skills/SkillPalette.tsx", /<Button variant="icon" aria-label=\{target\.cwd/],
  ["src/features/agents/CustomAgentForm.tsx", /variant="danger"\s+aria-label=\{t\("btn\.delete"\)\}/],
];

describe("botões só de ícone", () => {
  it.each(CASOS)("%s tem aria-label", (file, re) => {
    expect(readFileSync(file, "utf8")).toMatch(re);
  });
});
