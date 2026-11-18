import i18n from "i18next";

import { AlertaToast } from "@/shared/ui/alerts";

/** Avisa que os worktrees podem abrir o diálogo de confiança do Claude. */
export function showWorktreeTrustWarnings(warnings: string[] | undefined): void {
  if (!warnings?.length) return;
  void AlertaToast(
    i18n.t("missions.title"),
    i18n.t("missions.worktrees.trustWarning", { error: warnings.join("; ") }),
    "warning",
    9000,
  );
}
