/** Espelho de `src-tauri/src/canal/timeline.rs`. */

/**
 * `reasoning`: o trecho de raciocínio que o agente expõe. `usage`: os tokens de uma chamada (só para a conta do turno).
 * `notice`: um aviso do próprio app no fio (`label` = o código: `resumeLost`, `queueDropped`, `optionIgnored`, `toolOutcomeUnknown`, `turnTimeout`).
 */
export type TimelineItemKind = "user" | "assistant" | "tool" | "turnEnd" | "reasoning" | "usage" | "notice";
export type ToolKind = "read" | "edit" | "write" | "command" | "search" | "web" | "task" | "question" | "todo" | "other";
export type ToolStatus = "running" | "done" | "error" | "denied";
export type StepStatus = "pending" | "inProgress" | "completed";

/** Um passo do plano do agente (TodoWrite do Claude, `update_plan` do Codex). */
export interface PlanStep {
  text: string;
  status: StepStatus;
}

/** Categorias de tokens relatadas pelo provedor; algumas podem ser subconjuntos de outras. */
export interface UsageBreakdown {
  input?: number;
  output?: number;
  cached?: number;
  cacheWrite?: number;
  reasoning?: number;
  /** Indica se o raciocínio já está contado em `output`. Ausente quando o provedor não define isso. */
  reasoningInOutput?: boolean;
}

/**
 * O recurso de UI do MCP Apps (`ui://`) que a ferramenta devolveu, guardado pelo backend fora do `output` (que é
 * cortado). `html` já vem decodificado e limitado a 512 KiB.
 */
export interface TimelineAppResource {
  uri: string;
  mimeType: string;
  html: string;
}

export interface TimelineItem {
  kind: TimelineItemKind;
  id: string;
  at?: number;
  text?: string;
  name?: string;
  tool?: ToolKind;
  label?: string;
  path?: string;
  added?: number;
  removed?: number;
  status?: ToolStatus;
  output?: string;
  question?: { text: string; options: string[] };
  interrupted?: boolean;
  durationMs?: number;
  /** O plano publicado (ferramenta `todo`). */
  plan?: PlanStep[];
  /** Os tokens de um item `usage`. */
  tokens?: number;
  /** Categorias do uso informadas pelo agente, quando disponíveis. */
  usageBreakdown?: UsageBreakdown;
  /** Entrada de contexto informada pelo Claude, sem tokens de saída. */
  contextTokens?: number;
  /** A ADE já tentou compactar automaticamente a ponta deste contexto. */
  autoCompactAttempted?: boolean;
  /** O app MCP que a ferramenta devolveu. A tela o mostra isolado no lugar do resultado. */
  appResource?: TimelineAppResource;
}

export interface Timeline {
  items: TimelineItem[];
  /** O começo da conversa ficou de fora (transcript muito grande). */
  truncated: boolean;
}
