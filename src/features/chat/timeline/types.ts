/** Espelho de `src-tauri/src/canal/timeline.rs`. */

/** `reasoning`: o trecho de raciocínio que o agente expõe. `usage`: os tokens de uma chamada (só para a conta do turno). */
export type TimelineItemKind = "user" | "assistant" | "tool" | "turnEnd" | "reasoning" | "usage";
export type ToolKind = "read" | "edit" | "write" | "command" | "search" | "web" | "task" | "question" | "todo" | "other";
export type ToolStatus = "running" | "done" | "error" | "denied";
export type StepStatus = "pending" | "inProgress" | "completed";

/** Um passo do plano do agente (TodoWrite do Claude, `update_plan` do Codex). */
export interface PlanStep {
  text: string;
  status: StepStatus;
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
}

export interface Timeline {
  items: TimelineItem[];
  /** O começo da conversa ficou de fora (transcript muito grande). */
  truncated: boolean;
}
