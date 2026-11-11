import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { appConfirm } from "@/shared/ui/appConfirm";
import { SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";
import { storageCleanOld, storageOverview, type StorageArea } from "@/features/settings/ipc";
import { formatBytes, storageTotals } from "@/features/settings/storageModel";

/**
 * Configurações → Armazenamento (como o T3 Code). Mostra quanto ocupa cada pasta do app. A limpeza só atinge
 * capturas com mais de sete dias, e só depois de a pessoa confirmar, com o tamanho e a quantidade na tela. O
 * banco e as worktrees não têm botão: ficam como estão.
 */
export function StorageSettings() {
  const { t } = useTranslation();
  const [areas, setAreas] = useState<StorageArea[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    storageOverview()
      .then(setAreas)
      .catch(() => setError(t("settings.storage.error")));
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const clean = async (area: StorageArea) => {
    const ok = await appConfirm({
      title: t("settings.storage.clean.title"),
      lead: t("settings.storage.clean.lead", { size: formatBytes(area.oldBytes), count: area.oldFiles }),
      note: t("settings.storage.clean.note"),
      confirmLabel: t("settings.storage.clean.confirm"),
      cancelLabel: t("btn.cancel"),
      tone: "danger",
    });
    if (!ok) return;
    setBusy(area.id);
    setNotice(null);
    try {
      const done = await storageCleanOld(area.id);
      setNotice(t("settings.storage.clean.done", { size: formatBytes(done.bytes), count: done.files }));
      load();
    } catch {
      setError(t("settings.storage.clean.error"));
    } finally {
      setBusy(null);
    }
  };

  const totals = areas ? storageTotals(areas) : null;

  return (
    <SettingsSection
      title={t("settings.storage.title")}
      description={t("settings.storage.desc")}
      action={<Button variant="outline" size="sm" onClick={load}>{t("settings.storage.refresh")}</Button>}
    >
      <SettingsGroup>
        {error && <p className="m-0 px-4 py-3 text-[13px] text-red-600 dark:text-red-400">{error}</p>}
        {!areas && !error && <p className="m-0 px-4 py-3 text-[13px] text-gray-500 dark:text-white/50">{t("settings.storage.loading")}</p>}
        {areas?.map((area) => (
          <SettingsRow key={area.id} label={t(`settings.storage.area.${area.id}`)} hint={t(`settings.storage.area.${area.id}.hint`)}>
            <span className="flex items-center gap-3 text-[13px] text-gray-600 dark:text-white/60">
              <span className="tabular-nums">{formatBytes(area.bytes)}</span>
              <span className="text-gray-400 dark:text-white/40">{t("settings.storage.files", { count: area.files })}</span>
              {area.cleanable && (
                area.oldFiles > 0 ? (
                  <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void clean(area)}>
                    {t("settings.storage.clean", { size: formatBytes(area.oldBytes) })}
                  </Button>
                ) : (
                  <span className="text-[12px] text-gray-400 dark:text-white/40">{t("settings.storage.nothingOld")}</span>
                )
              )}
            </span>
          </SettingsRow>
        ))}
        {totals && (
          <div className="flex items-center justify-between gap-4 px-4 py-3 text-[13px] text-gray-500 dark:text-white/50">
            <span>{t("settings.storage.total")}</span>
            <span className="tabular-nums">{formatBytes(totals.bytes)} · {t("settings.storage.files", { count: totals.files })}</span>
          </div>
        )}
        {notice && <p role="status" className="m-0 px-4 py-3 text-[13px] text-gray-600 dark:text-white/60">{notice}</p>}
      </SettingsGroup>
    </SettingsSection>
  );
}
