import type { AiMemoryHandoff } from "@/features/memory/aiMemory";

const pending = new Set<string>();
/** Intenção efêmera: não se persiste nem reaplica em restart/reattach. */
export function requestContinuity(tabId: string): void {
  if (pending.size >= 128) pending.delete(pending.values().next().value!);
  pending.add(tabId);
}
export function takeContinuity(tabId?: string): boolean {
  return tabId ? pending.delete(tabId) : false;
}
function pathKey(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(clean) || clean.startsWith("//") ? clean.toLowerCase() : clean;
}
/** Mesma pasta/ancestral com fronteira de caminho; manuais sem cwd valem no projeto. */
export function pendingForClaude(rows: AiMemoryHandoff[], cwd: string): AiMemoryHandoff[] {
  const target = pathKey(cwd);
  return rows.filter((row) => {
    if (row.to_agent && !["claude", "claude-code"].includes(row.to_agent)) return false;
    if (!row.cwd) return true;
    const from = pathKey(row.cwd);
    return from !== "" && (from === target || target.startsWith(`${from}/`));
  }).sort((a, b) => b.created_at_ms - a.created_at_ms);
}
