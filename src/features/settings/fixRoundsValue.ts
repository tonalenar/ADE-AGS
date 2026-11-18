/** Interpreta o campo "Teto de correções". Vazio ou inválido não vira 0. */
export function parseFixRoundsInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 20) return null;
  return n;
}
