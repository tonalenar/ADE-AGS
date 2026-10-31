/**
 * O resumo de uma sequência de ferramentas ("Leu 1 arquivo, rodou 13 comandos · 1 falhou"): em vez de
 * uma linha por comando, o fio mostra uma linha só, recolhida. Puro; os textos vêm do i18n no
 * componente (`chat.work.*`), aqui só a conta.
 */
import { fileName } from "./timelineModel";
import { commandTitle } from "./toolTitle";
import type { TimelineItem, ToolKind } from "./types";

export interface WorkPart {
  kind: ToolKind;
  count: number;
}

export interface WorkSummary {
  /** Um por tipo, na ordem em que o tipo apareceu pela primeira vez. */
  parts: WorkPart[];
  /** Ferramentas com erro ou recusadas. */
  failed: number;
  /** Ferramentas ainda rodando. */
  running: number;
  /** A última ferramenta do grupo (a atividade atual, enquanto o turno roda). */
  last: TimelineItem | null;
}

/** Arquivos contam uma vez cada (lê o mesmo duas vezes = 1); o resto, uma por chamada. */
const COUNTS_FILES = new Set<ToolKind>(["read", "edit", "write"]);

export function summarizeTools(tools: TimelineItem[]): WorkSummary {
  const order: ToolKind[] = [];
  const calls = new Map<ToolKind, number>();
  const paths = new Map<ToolKind, Set<string>>();
  let failed = 0;
  let running = 0;
  for (const tool of tools) {
    const kind = tool.tool ?? "other";
    if (!order.includes(kind)) order.push(kind);
    if (COUNTS_FILES.has(kind) && tool.path) {
      const seen = paths.get(kind) ?? new Set<string>();
      seen.add(tool.path);
      paths.set(kind, seen);
    } else {
      calls.set(kind, (calls.get(kind) ?? 0) + 1);
    }
    if (tool.status === "error" || tool.status === "denied") failed++;
    if (tool.status === "running") running++;
  }
  return {
    parts: order.map((kind) => ({ kind, count: (calls.get(kind) ?? 0) + (paths.get(kind)?.size ?? 0) })),
    failed,
    running,
    last: tools[tools.length - 1] ?? null,
  };
}

/** "leu 1 arquivo" + "rodou 13 comandos" → "Leu 1 arquivo, rodou 13 comandos". Pura. */
export function joinParts(texts: string[]): string {
  const joined = texts.join(", ");
  return joined ? joined.charAt(0).toLocaleUpperCase() + joined.slice(1) : "";
}

/** O que a ferramenta está fazendo, curto e numa linha: o comando sem o invólucro, ou o nome do arquivo. Pura. */
export function activityOf(tool: TimelineItem | null): string {
  if (!tool) return "";
  if (tool.tool === "command") {
    const { program, rest } = commandTitle(tool.label ?? "");
    return rest ? `${program} ${rest}` : program;
  }
  if (tool.path) return fileName(tool.path);
  return tool.label ?? "";
}
