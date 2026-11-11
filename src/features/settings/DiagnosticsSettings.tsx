import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";
import { diagnosticsSnapshot, type DiagnosticsSnapshot } from "@/features/settings/ipc";
import { formatBytes } from "@/features/settings/storageModel";

/**
 * Configurações → Diagnóstico (como o T3 Code, só leitura). A versão, a pasta de dados, o tamanho do banco e
 * os terminais vivos com a saída que cada um já produziu. Nada aqui envia sinal a processo: quem encerra um
 * terminal é a aba dele.
 */
export function DiagnosticsSettings() {
  const { t } = useTranslation();
  const [snap, setSnap] = useState<DiagnosticsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    diagnosticsSnapshot()
      .then(setSnap)
      .catch(() => setError(t("settings.diagnostics.error")));
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <SettingsSection
      title={t("settings.diagnostics.title")}
      description={t("settings.diagnostics.desc")}
      action={<Button variant="outline" size="sm" onClick={load}>{t("settings.diagnostics.refresh")}</Button>}
    >
      <SettingsGroup>
        {error && <p className="m-0 px-4 py-3 text-[13px] text-red-600 dark:text-red-400">{error}</p>}
        {!snap && !error && <p className="m-0 px-4 py-3 text-[13px] text-gray-500 dark:text-white/50">{t("settings.diagnostics.loading")}</p>}
        {snap && (
          <>
            <SettingsRow label={t("settings.diagnostics.version")}>
              <span className="font-mono text-[12.5px] text-gray-600 dark:text-white/60">{snap.version}</span>
            </SettingsRow>
            <SettingsRow label={t("settings.diagnostics.dataDir")} hint={snap.isolated ? t("settings.diagnostics.isolated") : undefined}>
              <span className="max-w-[340px] truncate font-mono text-[12px] text-gray-600 dark:text-white/60" title={snap.dataDir ?? ""}>
                {snap.dataDir ?? t("settings.diagnostics.noDataDir")}
              </span>
            </SettingsRow>
            <SettingsRow label={t("settings.diagnostics.database")}>
              <span className="tabular-nums text-[12.5px] text-gray-600 dark:text-white/60">{formatBytes(snap.databaseBytes)}</span>
            </SettingsRow>
            <div className="flex flex-col gap-2 px-4 py-3.5">
              <span className="text-[14px] font-medium text-gray-900 dark:text-white">{t("settings.diagnostics.terminals")}</span>
              {snap.terminals.length === 0 ? (
                <p className="m-0 text-[13px] text-gray-500 dark:text-white/50">{t("settings.diagnostics.terminals.empty")}</p>
              ) : (
                <table className="w-full border-collapse text-left text-[12.5px]">
                  <thead>
                    <tr className="text-gray-400 dark:text-white/40">
                      <th className="py-1 font-normal">{t("settings.diagnostics.terminals.id")}</th>
                      <th className="py-1 font-normal">{t("settings.diagnostics.terminals.tab")}</th>
                      <th className="py-1 text-right font-normal">{t("settings.diagnostics.terminals.output")}</th>
                    </tr>
                  </thead>
                  <tbody className="text-gray-700 dark:text-white/70">
                    {snap.terminals.map((terminal) => (
                      <tr key={terminal.id} className="border-t border-gray-100 dark:border-white/[0.06]">
                        <td className="py-1 font-mono tabular-nums">{terminal.id}</td>
                        <td className="max-w-[220px] truncate py-1 font-mono">{terminal.tabId ?? "—"}</td>
                        <td className="py-1 text-right tabular-nums">{formatBytes(terminal.outputBytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <p className="m-0 px-4 pb-3.5 text-[12px] leading-[17px] text-gray-400 dark:text-white/40">{t("settings.diagnostics.readonly")}</p>
          </>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
