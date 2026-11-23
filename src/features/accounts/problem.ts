import { formatRemaining, type LiveUsage } from "./usage";

const legacyProblems: Record<string, string> = {
  "La TUI pidió confirmar que confiás en la carpeta": "accounts.plan.problem.trustRequired",
  "La TUI no mostró el panel de consumo a tiempo": "accounts.plan.problem.timeout",
  "La TUI no llegó a arrancar": "accounts.plan.problem.startup",
  "No se conoce el comando de Claude Code": "accounts.plan.problem.commandUnknown",
  "Claude Code no está instalado": "accounts.plan.problem.notInstalled",
  "No se pudo resolver la configuración de la cuenta": "accounts.plan.problem.configUnavailable",
  "La carpeta del sondeo tiene un nombre ilegible": "accounts.plan.problem.probePath",
  "No se encontró el panel de consumo en la salida": "accounts.plan.problem.panelMissing",
};

const problemKeys = new Set([
  ...Object.values(legacyProblems),
  "accounts.plan.problem.configRead",
  "accounts.plan.problem.configWrite",
  "accounts.plan.problem.rateLimited",
  "accounts.plan.problem.loadFailed",
  "accounts.plan.problem.apiKey",
  "accounts.auth.expired",
  "accounts.auth.required",
]);

const AUTH_PROBLEM_KEYS = new Set(["accounts.auth.expired", "accounts.auth.required"]);

/** Supports older backends and stored CLI errors without changing their diagnostics. */
export function accountProblemKey(problem: string | null): string | null {
  if (!problem) return null;
  if (problemKeys.has(problem)) return problem;
  if (legacyProblems[problem]) return legacyProblems[problem];
  if (/OAuth session expired|OAuth token (?:has )?expired/i.test(problem)) return "accounts.auth.expired";
  if (/not logged in|please run \/login/i.test(problem)) return "accounts.auth.required";
  if (/temporarily limiting requests|rate[- ]?limit(?:ed)?|too many requests|\b429\b/i.test(problem)) {
    return "accounts.plan.problem.rateLimited";
  }
  if (/couldn'?t load usage data|failed to load usage data/i.test(problem)) {
    return "accounts.plan.problem.loadFailed";
  }
  if (problem.startsWith("No se pudo leer ")) return "accounts.plan.problem.configRead";
  if (/^No se pudo (?:crear|escribir|actualizar) |^No se pudieron ajustar los permisos de /.test(problem)) {
    return "accounts.plan.problem.configWrite";
  }
  return null;
}

export function isAuthProblem(problem: string | null | undefined): boolean {
  if (!problem) return false;
  const key = accountProblemKey(problem);
  return key !== null && AUTH_PROBLEM_KEYS.has(key);
}

/** Conserva a última leitura válida quando uma atualização falha por erro transitório. */
export function mergeClaudeUsage(prev: LiveUsage | undefined, next: LiveUsage): LiveUsage {
  if (next.available) return next;
  if (prev?.available && !isAuthProblem(next.problem)) {
    return {
      ...prev,
      cached: true,
      problem: next.problem ?? prev.problem ?? "accounts.plan.failed",
      retryAt: next.retryAt ?? null,
    };
  }
  return next;
}

export function accountProblemText(
  problem: string | null,
  t: (key: string, vars?: Record<string, unknown>) => string,
  retryInSeconds?: number | null,
): string {
  const key = accountProblemKey(problem);
  if (key === "accounts.plan.problem.rateLimited" && retryInSeconds && retryInSeconds > 0) {
    return t("accounts.plan.problem.rateLimitedRetry", { time: formatRemaining(retryInSeconds) });
  }
  return key ? t(key) : (problem || t("accounts.plan.failed"));
}
