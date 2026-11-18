/** Aceita rascunho com ponto (`0.`, `.5`) sem forçar Number() a cada tecla. */
export function parseFloatDraft(raw: string): { kind: "draft" } | { kind: "number"; value: number } | { kind: "invalid" } {
  const text = raw.trim();
  if (text === "" || text === "-" || text === "." || text === "-.") return { kind: "draft" };
  if (!/^-?\d*\.?\d*$/.test(text) || text === "-") return { kind: "invalid" };
  if (text.endsWith(".")) return { kind: "draft" };
  const n = Number(text);
  if (!Number.isFinite(n)) return { kind: "invalid" };
  return { kind: "number", value: n };
}
