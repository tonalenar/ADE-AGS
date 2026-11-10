export const CLAUDE_AUTO_COMPACT_WINDOWS_SETTING = "chat.claude_auto_compact_windows";
export const CLAUDE_MAIN_ACCOUNT_ID = "system:claude-code";
export const CLAUDE_AUTO_COMPACT_WINDOW_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

const MIN_WINDOW = 100_000;
const MAX_WINDOW = 1_000_000;

/** Lê os limites por perfil sem aceitar valores fora do intervalo do Claude Code. */
export function claudeAutoCompactWindows(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) =>
      typeof value === "number" && Number.isInteger(value) && value >= MIN_WINDOW && value <= MAX_WINDOW
        ? [[id, value]] : []));
  } catch {
    return {};
  }
}

/** Valor de auto-compactação aplicável a um perfil, se a pessoa definiu um. */
export function claudeAutoCompactWindow(raw: string | null, accountId?: string | null): number | null {
  const key = accountId ?? CLAUDE_MAIN_ACCOUNT_ID;
  return claudeAutoCompactWindows(raw)[key] ?? null;
}
