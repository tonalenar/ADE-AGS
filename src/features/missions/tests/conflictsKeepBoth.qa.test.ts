import { describe, expect, it } from "vitest";

import { bothIsSafe, conflictCount, parseConflicts, resolveConflicts } from "../conflicts";

describe("Merge Conflicts - QA 'Manter os Dois' Suite", () => {
  describe("Fixture 1: ROADMAP.md (Markdown estruturado)", () => {
    it("mescla itens adicionados concorrentemente no ROADMAP.md desduplicando linhas comuns", () => {
      const roadmapConflict = [
        "# Roadmap ADE AGS",
        "",
        "## Etapa 20 — Concluída",
        "- [x] Notificações Windows com AUMID estável",
        "",
        "<<<<<<< HEAD",
        "## Etapa 21 — Teto de custo e limpeza de worktrees",
        "- [x] Guarda de orçamento com limites de 80% e 100%",
        "- [ ] Limpeza de worktrees com dry-run",
        "- [x] Baseline de testes",
        "=======",
        "## Etapa 21 — Mapa da frota e zoom",
        "- [x] Visualização de frota com zoom e pan",
        "- [ ] Limpeza de worktrees com dry-run",
        "- [x] Baseline de testes",
        ">>>>>>> origin/master",
        "",
        "## Etapa 22 — Futuro",
      ].join("\n");

      const parsed = parseConflicts(roadmapConflict);
      expect(conflictCount(parsed)).toBe(1);
      expect(parsed.malformed).toBe(false);

      const resolution = resolveConflicts("docs/ade-ags/ROADMAP.md", roadmapConflict, "both");
      expect(resolution).not.toBeNull();
      expect(resolution!.valid).toBe(true);

      const result = resolution!.content;
      // Itens de ambos os lados devem estar presentes
      expect(result).toContain("## Etapa 21 — Teto de custo e limpeza de worktrees");
      expect(result).toContain("## Etapa 21 — Mapa da frota e zoom");
      expect(result).toContain("- [x] Guarda de orçamento com limites de 80% e 100%");
      expect(result).toContain("- [x] Visualização de frota com zoom e pan");
      // Linhas comuns compartilhadas não devem ser duplicadas
      const commonOccurrences = result.split("- [ ] Limpeza de worktrees com dry-run").length - 1;
      expect(commonOccurrences).toBe(1);
      const baselineOccurrences = result.split("- [x] Baseline de testes").length - 1;
      expect(baselineOccurrences).toBe(1);
    });

    it("suporta múltiplos hunks de conflito em seções diferentes do ROADMAP.md", () => {
      const multiHunkRoadmap = [
        "# Roadmap ADE AGS",
        "<<<<<<< HEAD",
        "- [x] Item topo por Worker A",
        "=======",
        "- [x] Item topo por Worker B",
        ">>>>>>> origin/master",
        "",
        "## Seção Intermediária",
        "Texto estático que não conflita",
        "",
        "<<<<<<< HEAD",
        "- [ ] Item rodapé por Worker A",
        "=======",
        "- [ ] Item rodapé por Worker B",
        ">>>>>>> origin/master",
      ].join("\n");

      const resolution = resolveConflicts("docs/ade-ags/ROADMAP.md", multiHunkRoadmap, "both");
      expect(resolution).not.toBeNull();
      expect(resolution!.content).toContain("- [x] Item topo por Worker A");
      expect(resolution!.content).toContain("- [x] Item topo por Worker B");
      expect(resolution!.content).toContain("Texto estático que não conflita");
      expect(resolution!.content).toContain("- [ ] Item rodapé por Worker A");
      expect(resolution!.content).toContain("- [ ] Item rodapé por Worker B");
    });

    it("preserva quebras de linha Windows CRLF ao resolver ROADMAP.md", () => {
      const crlfRoadmap =
        "# Roadmap\r\n<<<<<<< HEAD\r\n- Item A\r\n=======\r\n- Item B\r\n>>>>>>> origin/master\r\n";
      const resolution = resolveConflicts("docs/ade-ags/ROADMAP.md", crlfRoadmap, "both");
      expect(resolution).not.toBeNull();
      expect(resolution!.content).toBe("# Roadmap\r\n- Item A\r\n- Item B\r\n");
    });

    it("lê e ignora adequadamente o marcador de base diff3 (|||||||)", () => {
      const diff3Roadmap = [
        "<<<<<<< HEAD",
        "- Novo em ours",
        "||||||| base-commit",
        "- Versão original antiga",
        "=======",
        "- Novo em theirs",
        ">>>>>>> origin/master",
      ].join("\n");

      const parsed = parseConflicts(diff3Roadmap);
      expect(parsed.segments[0]!.kind).toBe("conflict");
      if (parsed.segments[0]!.kind === "conflict") {
        expect(parsed.segments[0]!.base).toEqual(["- Versão original antiga"]);
      }

      const resolution = resolveConflicts("docs/ade-ags/ROADMAP.md", diff3Roadmap, "both");
      expect(resolution).not.toBeNull();
      expect(resolution!.content).toBe("- Novo em ours\n- Novo em theirs");
    });
  });

  describe("Fixture 2: Locales JSON (pt-BR.json, en.json, es.json)", () => {
    it("mescla chaves concorrentes no fim do objeto JSON garantindo ausência de vírgula terminal inválida", () => {
      const jsonEndConflict = [
        "{",
        '  "app.title": "ADE AGS",',
        '  "common.ok": "OK",',
        "<<<<<<< HEAD",
        '  "missions.budget.warning": "80% do orçamento consumido",',
        '  "missions.budget.exceeded": "Orçamento estourado"',
        "=======",
        '  "missions.map.zoom": "Zoom no mapa",',
        '  "missions.map.pan": "Pan no mapa"',
        ">>>>>>> origin/master",
        "}",
      ].join("\n");

      const resolution = resolveConflicts("src/i18n/locales/pt-BR.json", jsonEndConflict, "both");
      expect(resolution).not.toBeNull();
      expect(resolution!.valid).toBe(true);

      const parsedJson = JSON.parse(resolution!.content);
      expect(parsedJson).toEqual({
        "app.title": "ADE AGS",
        "common.ok": "OK",
        "missions.budget.warning": "80% do orçamento consumido",
        "missions.budget.exceeded": "Orçamento estourado",
        "missions.map.zoom": "Zoom no mapa",
        "missions.map.pan": "Pan no mapa",
      });
    });

    it("mescla chaves no meio do objeto JSON garantindo que a última linha do bloco tenha vírgula para a chave seguinte", () => {
      const jsonMidConflict = [
        "{",
        '  "app.title": "ADE AGS",',
        "<<<<<<< HEAD",
        '  "first.a": "Alpha"',
        "=======",
        '  "first.b": "Beta"',
        ">>>>>>> origin/master",
        '  "final.key": "Omega"',
        "}",
      ].join("\n");

      const resolution = resolveConflicts("src/i18n/locales/en.json", jsonMidConflict, "both");
      expect(resolution).not.toBeNull();
      expect(resolution!.valid).toBe(true);

      const parsedJson = JSON.parse(resolution!.content);
      expect(parsedJson).toEqual({
        "app.title": "ADE AGS",
        "first.a": "Alpha",
        "first.b": "Beta",
        "final.key": "Omega",
      });
    });

    it("sinaliza invalidade quando o conteúdo dos ramos é sintaticamente corrompido antes da fusão", () => {
      const corruptedJson = [
        "{",
        "<<<<<<< HEAD",
        '  "chave": VALOR_SEM_ASPAS',
        "=======",
        '  "outra": "ok"',
        ">>>>>>> origin/master",
        "}",
      ].join("\n");

      const resolution = resolveConflicts("src/i18n/locales/es.json", corruptedJson, "both");
      expect(resolution).not.toBeNull();
      expect(resolution!.valid).toBe(false);
    });
  });

  describe("Segurança bothIsSafe e Tratamento de Erros", () => {
    it("bothIsSafe permite apenas arquivos de documentação e traduções", () => {
      expect(bothIsSafe("docs/ade-ags/ROADMAP.md")).toBe(true);
      expect(bothIsSafe("README.md")).toBe(true);
      expect(bothIsSafe("docs/guide.mdx")).toBe(true);
      expect(bothIsSafe("src/i18n/locales/pt-BR.json")).toBe(true);
      expect(bothIsSafe("src/i18n/locales/en.json")).toBe(true);
      expect(bothIsSafe("src/i18n/locales/es.json")).toBe(true);

      // Código de programação não deve usar mescla ingênua de ambos os lados
      expect(bothIsSafe("src-tauri/src/main.rs")).toBe(false);
      expect(bothIsSafe("src/features/missions/MissionMap.tsx")).toBe(false);
      expect(bothIsSafe("src/app/index.ts")).toBe(false);
    });

    it("rejeita conflito malformado com marcadores não balanceados retornando null", () => {
      const malformedConflict = [
        "# Roadmap",
        "<<<<<<< HEAD",
        "- Item sem fecha",
        "======= apenas meio",
      ].join("\n");

      const parsed = parseConflicts(malformedConflict);
      expect(parsed.malformed).toBe(true);
      expect(resolveConflicts("docs/ade-ags/ROADMAP.md", malformedConflict, "both")).toBeNull();
    });
  });
});
