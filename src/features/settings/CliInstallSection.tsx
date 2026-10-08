import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";
import { AnimateSpin, CheckCircleIcon, InfoIcon } from "neogestify-ui-components";
import { cliInstallStatus, installCli, uninstallCli, type CliInstallStatus } from "./ipc";
import { SettingsGroup, SettingsSection } from "@/features/settings/SettingsSection";

/**
 * Instala la CLI `ags` en el PATH del usuario.
 *
 * El binario ya viaja con la app, pero en macOS vive dentro del `.app` (que nunca está en
 * el PATH) y en Windows el caso portable tampoco lo agrega — de ahí este paso explícito,
 * el mismo que hace VS Code con su comando `code`. Nunca pide permisos de administrador.
 */
export function CliInstallSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CliInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await cliInstallStatus());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const run = async (action: () => Promise<CliInstallStatus>) => {
    setBusy(true);
    setError("");
    try {
      setStatus(await action());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={t("settings.cli")} description={t("settings.cli.desc")}>

      {status && (
        <div className="flex flex-col gap-3">
          <SettingsGroup>
            <div className="flex items-center gap-2 min-h-10 px-3 py-2">
              {status.installed ? (
                <>
                  <CheckCircleIcon className="w-4 h-4 shrink-0 text-emerald-500" />
                  <span className="text-[13px] text-gray-900 dark:text-gray-100">
                    {t("settings.cli.installed")}
                  </span>
                </>
              ) : (
                <span className="text-[13px] text-gray-500 dark:text-gray-400">
                  {t("settings.cli.notInstalled")}
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1.5 px-3 py-2.5">
              <span className="text-[11px] leading-[14px] uppercase tracking-[0.06em] font-semibold text-gray-500 dark:text-white/45">
                {t("settings.cli.location")}
              </span>
              <code className="font-mono text-[11.5px] leading-4 tabular-nums break-all text-gray-700 dark:text-gray-300">
                {status.targetPath}
              </code>
            </div>
          </SettingsGroup>

          {/* En macOS una app lanzada desde Finder hereda un PATH mínimo, no el de tu
              shell, así que esto puede ser un falso negativo. Por eso es un aviso con la
              línea a copiar, y no un error que bloquee. */}
          {status.installed && !status.dirInPath && (
            <div className="flex items-start gap-2.5 p-3 rounded-xl
              bg-amber-50 dark:bg-amber-500/10">
              <InfoIcon className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
              <div className="flex flex-col gap-1.5 min-w-0">
                <span className="text-[12px] leading-4 text-amber-700 dark:text-amber-300">
                  {t("settings.cli.notInPath")}
                </span>
                <code className="font-mono text-[11px] leading-4 break-all rounded-md px-2 py-1
                  bg-amber-100/70 dark:bg-surface-sunken
                  text-amber-800 dark:text-amber-200">
                  export PATH="{status.targetDir}:$PATH"
                </code>
              </div>
            </div>
          )}

          {status.method === "copy" && status.installed && (
            <p className="text-[11.5px] leading-4 text-gray-500 dark:text-white/40">
              {t("settings.cli.copyNote")}
            </p>
          )}

          {!status.sourcePath && (
            <p className="text-[12px] leading-4 text-amber-600 dark:text-amber-400">
              {t("settings.cli.noBinary")}
            </p>
          )}

          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              disabled={busy || !status.sourcePath}
              onClick={() => run(installCli)}
              className="!text-sm"
              leftIcon={busy ? <AnimateSpin className="w-4 h-4" /> : undefined}
            >
              {status.installed ? t("settings.cli.reinstall") : t("settings.cli.install")}
            </Button>
            {status.installed && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => run(uninstallCli)}
                className="!text-sm"
              >
                {t("settings.cli.uninstall")}
              </Button>
            )}
          </div>

          <p className="text-[11.5px] leading-4 text-gray-500 dark:text-white/40">
            {t("settings.cli.usage")}
          </p>
        </div>
      )}

      {error && <p className="text-[12px] leading-4 text-red-500 dark:text-red-400">{error}</p>}
    </SettingsSection>
  );
}
