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
  "accounts.auth.expired",
  "accounts.auth.required",
]);

/** Supports older backends and stored CLI errors without changing their diagnostics. */
export function accountProblemKey(problem: string | null): string | null {
  if (!problem) return null;
  if (problemKeys.has(problem)) return problem;
  if (legacyProblems[problem]) return legacyProblems[problem];
  if (/OAuth session expired|OAuth token (?:has )?expired/i.test(problem)) return "accounts.auth.expired";
  if (/not logged in|please run \/login/i.test(problem)) return "accounts.auth.required";
  if (problem.startsWith("No se pudo leer ")) return "accounts.plan.problem.configRead";
  if (/^No se pudo (?:crear|escribir|actualizar) |^No se pudieron ajustar los permisos de /.test(problem)) {
    return "accounts.plan.problem.configWrite";
  }
  return null;
}

export function accountProblemText(problem: string | null, t: (key: string) => string): string {
  const key = accountProblemKey(problem);
  return key ? t(key) : (problem || t("accounts.plan.failed"));
}
