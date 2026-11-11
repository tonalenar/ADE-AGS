import { isUnknownOutcome, type BodyRow, type Turn } from "./timelineModel";
import type { TimelineItem } from "./types";

/**
 * "Chamadas de ferramenta no chat" (Configurações → Chat → Atividade), como o T3 Code: o que some do
 * fold "Trabalhou por …". `showAll` mostra tudo; `hideSuccessful` esconde as que deram certo; `hideAll`
 * esconde comandos, edições, buscas e leituras; `zen` mostra só as respostas finais. Perguntas,
 * aprovações, planos, tarefas de sub-agente e erros sempre aparecem. Pura, sobre os turnos já montados.
 */

export type ToolCallVisibility = "showAll" | "hideSuccessful" | "hideAll" | "zen";

export const TOOL_CALL_VISIBILITIES: readonly ToolCallVisibility[] = ["showAll", "hideSuccessful", "hideAll", "zen"];

export function isToolCallVisibility(value: unknown): value is ToolCallVisibility {
  return value === "showAll" || value === "hideSuccessful" || value === "hideAll" || value === "zen";
}

/** O que nunca some, qualquer que seja o modo: pergunta, aprovação, plano, tarefa, erro, negação e o desfecho desconhecido. */
export function alwaysShownTool(item: TimelineItem): boolean {
  if (item.tool === "question" || item.tool === "todo" || item.tool === "task") return true;
  if (item.status === "error" || item.status === "denied") return true;
  return isUnknownOutcome(item);
}

function toolShown(item: TimelineItem, mode: ToolCallVisibility): boolean {
  if (mode === "showAll" || alwaysShownTool(item)) return true;
  // Em andamento fica: ainda não deu certo nem errado, e some quando terminar sem erro.
  if (mode === "hideSuccessful") return item.status !== "done";
  return false;
}

/** As linhas do corpo que sobram. Uma linha de ferramentas sem nenhuma ferramenta visível some. */
function rowsShown(rows: BodyRow[], mode: ToolCallVisibility): BodyRow[] {
  const shown: BodyRow[] = [];
  for (const row of rows) {
    if (row.type === "question") {
      shown.push(row);
    } else if (row.type === "assistant") {
      // Falas do meio do trabalho: o zen esconde; as outras não somem com as ferramentas.
      if (mode !== "zen") shown.push(row);
    } else {
      const tools = row.tools.filter((tool) => toolShown(tool, mode));
      if (tools.length === row.tools.length) shown.push(row);
      else if (tools.length > 0) shown.push({ ...row, tools });
    }
  }
  return shown;
}

/** Os turnos com o corpo filtrado pelo modo. `showAll` devolve os mesmos turnos, sem copiar. */
export function applyToolCallVisibility(turns: Turn[], mode: ToolCallVisibility): Turn[] {
  if (mode === "showAll") return turns;
  return turns.map((turn) => ({ ...turn, body: rowsShown(turn.body, mode) }));
}
