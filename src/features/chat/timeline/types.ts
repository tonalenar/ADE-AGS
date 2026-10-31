/** Espelho de `src-tauri/src/canal/timeline.rs`. */

export type TimelineItemKind = "user" | "assistant" | "tool" | "turnEnd";
export type ToolKind = "read" | "edit" | "write" | "command" | "search" | "web" | "task" | "question" | "todo" | "other";
export type ToolStatus = "running" | "done" | "error" | "denied";

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
}

export interface Timeline {
  items: TimelineItem[];
  /** O começo da conversa ficou de fora (transcript muito grande). */
  truncated: boolean;
}
