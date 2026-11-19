import type { WorkMode } from "@/features/canvas/store";

/**
 * Como o compositor de conversa nova aparece fora da casca de chat: no Canvas ele flutua
 * sobre o quadro (que continua visível); nas Abas e nas outras telas, ocupa a área toda.
 */
export function composerLayout(workMode: WorkMode, isWorkspace: boolean): "floating" | "full" {
  return isWorkspace && workMode === "canvas" ? "floating" : "full";
}
