/** O flash de cada prancheta tem o próprio timer; um reload não apaga o anterior. */
export function mergeAgentFlash(current: Record<string, true>, bumped: string[]): Record<string, true> {
  const next = { ...current };
  for (const id of bumped) next[id] = true;
  return next;
}

export function clearAgentFlashIds(current: Record<string, true>, ids: string[]): Record<string, true> {
  const next = { ...current };
  for (const id of ids) delete next[id];
  return next;
}
