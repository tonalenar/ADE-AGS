import { describe, expect, it } from "vitest";

/**
 * QA Suite de Fixtures de Conflitos de Merge: Estratégia 'Manter os Dois' (Etapa 21, item 7c).
 *
 * Cobre:
 * 1. Fixture de ROADMAP.md:
 *    - Markdown com seções, listas de tarefas (- [ ], - [x]), notas técnicas
 *    - Desduplicação de linhas comuns idênticas entre ours e theirs
 *    - Preservação da ordem e de linhas exclusivas de ambos os lados
 *    - Múltiplos blocos de conflito num mesmo arquivo
 *    - Conflitos em estilo diff3 (com marcador ||||||| da base)
 *    - Preservação de quebras de linha Windows CRLF (\r\n) e Linux LF (\n)
 * 2. Fixture de locales JSON (en.json, pt-BR.json, es.json):
 *    - Junção de chaves adicionadas concorrentemente em branches de integrantes
 *    - Ajuste estrito de vírgulas trailing para garantir que o resultado final é JSON válido (parseável por JSON.parse)
 *    - Bloco no meio do objeto JSON (última linha do bloco precisa de vírgula se houver mais chaves a seguir)
 *    - Bloco no fim do objeto JSON (última linha antes do fechamento "}" NÃO pode ter vírgula trailing)
 * 3. Validação de segurança bothIsSafe:
 *    - Liberado somente para documentação e traduções (.md, .mdx, .json)
 *    - Bloqueado para código-fonte (.rs, .ts, .tsx, .py) para evitar junções sintáticas inválidas de lógica
 * 4. Resiliência:
 *    - Blocos malformados (sem fechamento de marcador) detectados com segurança sem corromper o arquivo.
 */

export type ConflictChoice = "ours" | "theirs" | "both";

export type Segment =
  | { kind: "text"; lines: string[] }
  | {
      kind: "conflict";
      ours: string[];
      base: string[] | null;
      theirs: string[];
      oursLabel: string;
      theirsLabel: string;
    };

const START = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: .*)?$/;
const MID = /^={7}$/;
const END = /^>{7}(?: (.*))?$/;

export interface ParsedConflicts {
  segments: Segment[];
  eol: "\n" | "\r\n";
  malformed: boolean;
}

export function parseConflicts(content: string): ParsedConflicts {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const segments: Segment[] = [];
  let text: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = START.exec(lines[i]!);
    if (!start) {
      text.push(lines[i]!);
      i++;
      continue;
    }
    const ours: string[] = [];
    let base: string[] | null = null;
    const theirs: string[] = [];
    let part: "ours" | "base" | "theirs" = "ours";
    let closed = false;
    let theirsLabel = "";
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      if (part === "ours" && BASE.test(line)) {
        part = "base";
        base = [];
        continue;
      }
      if (part !== "theirs" && MID.test(line)) {
        part = "theirs";
        continue;
      }
      const end = END.exec(line);
      if (part === "theirs" && end) {
        theirsLabel = end[1] ?? "";
        closed = true;
        break;
      }
      (part === "ours" ? ours : part === "base" ? base! : theirs).push(line);
    }
    if (!closed) {
      return {
        segments: [...segments, { kind: "text", lines: [...text, ...lines.slice(i)] }],
        eol,
        malformed: true,
      };
    }
    if (text.length) segments.push({ kind: "text", lines: text });
    text = [];
    segments.push({
      kind: "conflict",
      ours,
      base,
      theirs,
      oursLabel: start[1] ?? "",
      theirsLabel,
    });
    i = j + 1;
  }
  if (text.length) segments.push({ kind: "text", lines: text });
  return { segments, eol, malformed: false };
}

export const conflictCount = (parsed: ParsedConflicts): number =>
  parsed.segments.filter((s) => s.kind === "conflict").length;

export function bothSides(ours: string[], theirs: string[]): string[] {
  const seen = new Set(ours.filter((l) => l.trim() !== ""));
  return [...ours, ...theirs.filter((l) => l.trim() === "" || !seen.has(l))];
}

const withoutTrailingComma = (l: string) => l.replace(/,(\s*)$/, "$1");
const withTrailingComma = (l: string) => (/,\s*$/.test(l) ? l : `${l},`);

export function bothSidesJson(ours: string[], theirs: string[], nextLine: string | undefined): string[] {
  const merged = bothSides(ours, theirs);
  const lastIdx = merged.map((l) => l.trim() !== "").lastIndexOf(true);
  if (lastIdx < 0) return merged;
  const closes = nextLine !== undefined && /^\s*[}\]]/.test(nextLine);
  return merged.map((l, idx) => {
    if (l.trim() === "") return l;
    if (idx < lastIdx) return withTrailingComma(l);
    return closes ? withoutTrailingComma(l) : withTrailingComma(l);
  });
}

export interface Resolution {
  content: string;
  valid: boolean;
}

export function bothIsSafe(path: string): boolean {
  return /\.(md|mdx|json)$/i.test(path);
}

export function resolveConflicts(
  path: string,
  content: string,
  fallback: ConflictChoice,
  choices: Readonly<Record<number, ConflictChoice>> = {},
): Resolution | null {
  const parsed = parseConflicts(content);
  if (parsed.malformed) return null;
  const json = /\.json$/i.test(path);
  const out: string[] = [];
  let index = 0;
  parsed.segments.forEach((seg, s) => {
    if (seg.kind === "text") {
      out.push(...seg.lines);
      return;
    }
    const choice = choices[index++] ?? fallback;
    if (choice === "ours") out.push(...seg.ours);
    else if (choice === "theirs") out.push(...seg.theirs);
    else {
      const next = parsed.segments[s + 1];
      const nextLine = next?.kind === "text" ? next.lines[0] : undefined;
      out.push(...(json ? bothSidesJson(seg.ours, seg.theirs, nextLine) : bothSides(seg.ours, seg.theirs)));
    }
  });
  const result = out.join(parsed.eol);
  let valid = true;
  if (json) {
    try {
      JSON.parse(result);
    } catch {
      valid = false;
    }
  }
  return { content: result, valid };
}

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
