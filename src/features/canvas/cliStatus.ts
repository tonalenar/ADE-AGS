import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { AlertaToast } from "neogestify-ui-components";

export interface BuildInfo { version: string; buildHash?: string; buildDate?: string }
export interface CliBuildStatus {
  outdated: boolean;
  app: BuildInfo;
  cli: BuildInfo | null;
  path: string;
  reason: string | null;
}

/** O que mostrar no aviso "CLI desatualizado" (versão do CLI, ou "?" se nem existe ao lado do app). Pura. */
export function cliOutdatedDetail(status: CliBuildStatus): { cli: string; app: string } | null {
  if (!status.outdated) return null;
  const label = (b: BuildInfo | null) => (b ? `${b.version}${b.buildHash ? ` (${b.buildHash.slice(0, 7)})` : ""}` : "?");
  return { cli: label(status.cli), app: label(status.app) };
}

let warned = false;

/** Avisa uma vez por sessão se o `ags` ao lado do app é de outra versão (só o app é recompilado por `tauri dev`). */
export function useCliOutdatedNotice(): void {
  const { t } = useTranslation();
  useEffect(() => {
    if (warned) return;
    invoke<CliBuildStatus>("cli_build_status").then((status) => {
      const d = cliOutdatedDetail(status);
      if (!d || warned) return;
      warned = true;
      AlertaToast(t("cli.outdated"), t("cli.outdatedHint", d), "warning", 10000);
    }).catch(() => {});
  }, [t]);
}
