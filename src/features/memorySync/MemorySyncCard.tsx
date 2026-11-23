import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, CheckCircleIcon, InfoIcon, Input } from "neogestify-ui-components";

import { useUiStore } from "@/app/uiStore";
import { useForgeStore } from "@/features/forge/store";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
} from "@/features/settings/SettingsSection";
import { openExternalUrl } from "@/shared/openExternalUrl";
import { PopupSelect } from "@/shared/ui/PopupSelect";

import { useMemorySyncStore } from "./store";
import { memorySyncWarning } from "./types";

const DEFAULT_REPO_NAME = "ade-memoria";
const INTERVAL_OPTIONS = [1, 3, 6, 12, 24] as const;

interface MemorySyncCardProps {
  activeCwd: string;
  workspaceId: string | null;
}

function repoShortName(fullName: string | null): string {
  if (!fullName) return DEFAULT_REPO_NAME;
  const tail = fullName.split("/").pop()?.trim();
  return tail || DEFAULT_REPO_NAME;
}

function isSafeHttpUrl(url: string | null): url is string {
  return Boolean(url && (url.startsWith("https://") || url.startsWith("http://")));
}

/**
 * Cartão de sincronização opcional de memórias para repositório GitHub privado
 * (Configurações → Memória). Nasce desligado por padrão; nunca apaga dados ao desligar.
 */
export function MemorySyncCard({ activeCwd, workspaceId }: MemorySyncCardProps) {
  const { t, i18n } = useTranslation();
  const status = useMemorySyncStore((s) => s.status);
  const running = useMemorySyncStore((s) => s.running);
  const storeError = useMemorySyncStore((s) => s.error);
  const load = useMemorySyncStore((s) => s.load);
  const setup = useMemorySyncStore((s) => s.setup);
  const setEnabled = useMemorySyncStore((s) => s.setEnabled);
  const setAuto = useMemorySyncStore((s) => s.setAuto);
  const syncNow = useMemorySyncStore((s) => s.syncNow);
  const restoreNow = useMemorySyncStore((s) => s.restoreNow);
  const resolveConflict = useMemorySyncStore((s) => s.resolveConflict);

  const accounts = useForgeStore((s) => s.accounts);
  const loadAccounts = useForgeStore((s) => s.load);
  const setAccountsOpen = useUiStore((s) => s.setAccountsOpen);

  const lastWarning = status?.last ? memorySyncWarning(status.last) : null;

  const eligibleAccounts = accounts.filter((account) => account.kind !== "other");

  const [configuring, setConfiguring] = useState(false);
  const [editingTarget, setEditingTarget] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [repoName, setRepoName] = useState(DEFAULT_REPO_NAME);

  useEffect(() => {
    void load().catch(() => {});
    void loadAccounts().catch(() => {});
  }, [load, loadAccounts]);

  useEffect(() => {
    if (!status?.repo) return;
    setRepoName(repoShortName(status.repo));
  }, [status?.repo]);

  const effectiveAccountId =
    eligibleAccounts.some((acc) => acc.id === selectedAccountId)
      ? selectedAccountId
      : eligibleAccounts.some((acc) => acc.id === status?.accountId)
        ? (status?.accountId ?? "")
        : (eligibleAccounts[0]?.id ?? "");

  const isConfigured = Boolean(status?.configured);
  const mainChecked = isConfigured ? Boolean(status?.enabled) : configuring;
  const showSetupForm = (!isConfigured && configuring) || editingTarget;
  const visibleError = storeError ?? status?.lastError ?? null;

  const handleMainToggle = (next: boolean) => {
    if (!isConfigured) {
      setConfiguring(next);
      return;
    }
    if (!next) {
      setEditingTarget(false);
    }
    void setEnabled(next);
  };

  const handleConnect = async () => {
    const cleanRepo = repoName.trim() || DEFAULT_REPO_NAME;
    if (!effectiveAccountId) return;
    await setup(effectiveAccountId, cleanRepo);
    const updated = useMemorySyncStore.getState();
    if (updated.status?.configured && !updated.error) {
      setConfiguring(false);
      setEditingTarget(false);
    }
  };

  const formatDateTime = (unixSeconds: number) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(unixSeconds * 1000));

  return (
    <SettingsSection title={t("memorySync.title")} description={t("memorySync.description")}>
      <SettingsGroup>
        <SettingsToggleRow
          checked={mainChecked}
          disabled={!status || running}
          onChange={handleMainToggle}
          label={t("memorySync.toggle.label")}
          description={t("memorySync.toggle.desc")}
        />

        {showSetupForm && (
          <>
            {eligibleAccounts.length === 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                <span className="text-[12.5px] text-gray-600 dark:text-white/60">
                  {accounts.length > 0 ? t("memorySync.needApiAccount") : t("memorySync.needAccount")}
                </span>
                <div className="flex items-center gap-2">
                  {editingTarget && (
                    <Button variant="ghost" size="sm" onClick={() => setEditingTarget(false)}>
                      {t("memorySync.cancel")}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setAccountsOpen(true)}>
                    {t("memorySync.openAccounts")}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <SettingsRow label={t("memorySync.account")} hint={t("memorySync.accountHint")}>
                  <PopupSelect
                    aria-label={t("memorySync.account")}
                    value={effectiveAccountId}
                    disabled={running}
                    onChange={(event) => setSelectedAccountId(event.target.value)}
                    className="min-w-48"
                  >
                    {eligibleAccounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {`${acc.login} (${acc.host})`}
                      </option>
                    ))}
                  </PopupSelect>
                </SettingsRow>
                <SettingsRow label={t("memorySync.repoName")} hint={t("memorySync.repoHelper")}>
                  <Input
                    type="text"
                    aria-label={t("memorySync.repoName")}
                    value={repoName}
                    disabled={running}
                    onChange={(event) => setRepoName(event.target.value)}
                    placeholder={DEFAULT_REPO_NAME}
                    variant="outline"
                    className="w-52"
                  />
                </SettingsRow>
                <div className="flex items-center justify-end gap-2 px-4 py-3">
                  {editingTarget && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={running}
                      onClick={() => setEditingTarget(false)}
                    >
                      {t("memorySync.cancel")}
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={running || !effectiveAccountId || !repoName.trim()}
                    onClick={() => void handleConnect()}
                  >
                    {running && <AnimateSpin className="w-3.5 h-3.5 mr-1.5" />}
                    {running ? t("memorySync.connecting") : t("memorySync.connect")}
                  </Button>
                </div>
              </>
            )}
          </>
        )}

        {isConfigured && status && (
          <>
            <SettingsRow
              label={t("memorySync.target")}
              hint={t("memorySync.privateOnlyHint")}
            >
              <div className="flex items-center gap-2">
                {isSafeHttpUrl(status.webUrl) ? (
                  <button
                    type="button"
                    onClick={() => void openExternalUrl(status.webUrl!)}
                    className="text-[13px] font-medium text-accent-600 dark:text-accent-400 hover:underline"
                  >
                    {status.repo}
                  </button>
                ) : (
                  <span className="text-[13px] font-medium text-gray-800 dark:text-white/85">
                    {status.repo}
                  </span>
                )}
                <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                  {t("memorySync.privateBadge")}
                </span>
                {!editingTarget && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={running}
                    onClick={() => setEditingTarget(true)}
                  >
                    {t("memorySync.changeTarget")}
                  </Button>
                )}
              </div>
            </SettingsRow>

            {!status.enabled && (
              <div className="flex items-start gap-2.5 px-4 py-3 text-[12.5px] text-gray-600 dark:text-white/60">
                <InfoIcon className="w-4 h-4 mt-0.5 shrink-0 text-gray-400 dark:text-white/40" />
                <span>{t("memorySync.pausedNote")}</span>
              </div>
            )}

            <SettingsToggleRow
              checked={status.autoEnabled}
              disabled={!status.enabled || running}
              onChange={(value) => void setAuto(value, status.intervalHours)}
              label={t("memorySync.auto")}
              description={t("memorySync.autoHint")}
            />

            {status.autoEnabled && (
              <SettingsRow label={t("memorySync.interval")}>
                <PopupSelect
                  aria-label={t("memorySync.interval")}
                  value={String(status.intervalHours)}
                  disabled={!status.enabled || running}
                  onChange={(event) => void setAuto(true, Number(event.target.value))}
                  className="min-w-36"
                >
                  {INTERVAL_OPTIONS.map((hours) => (
                    <option key={hours} value={String(hours)}>
                      {t("memorySync.intervalHours", { count: hours })}
                    </option>
                  ))}
                </PopupSelect>
              </SettingsRow>
            )}

            <SettingsRow label={t("memorySync.manual")} hint={t("memorySync.oneWayNote")}>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!status.enabled || running}
                  onClick={() => void restoreNow()}
                >
                  {running && <AnimateSpin className="w-3.5 h-3.5 mr-1.5" />}
                  {t("memorySync.restoreNow")}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!status.enabled || running}
                  onClick={() => void syncNow(workspaceId, activeCwd)}
                >
                  {running && <AnimateSpin className="w-3.5 h-3.5 mr-1.5" />}
                  {running ? t("memorySync.sending") : t("memorySync.sendNow")}
                </Button>
              </div>
            </SettingsRow>
          </>
        )}
      </SettingsGroup>

      {status?.last && (
        <div className="flex flex-col gap-2 rounded-xl border border-gray-200 dark:border-white/10 bg-gray-50/70 dark:bg-white/[0.03] px-4 py-3 text-[12.5px]">
          <div className="flex flex-wrap items-center gap-2 text-gray-800 dark:text-white/85">
            {lastWarning ? (
              <InfoIcon className="w-4 h-4 shrink-0 text-amber-500" />
            ) : (
              <CheckCircleIcon className="w-4 h-4 shrink-0 text-emerald-500" />
            )}
            <span className="font-medium">
              {t(status.last.restored ? "memorySync.lastRestore" : "memorySync.last", { time: formatDateTime(status.last.at) })}
            </span>
            {!status.last.restored && <span className="text-gray-500 dark:text-white/50">
              {status.last.pushed ? t("memorySync.pushed") : t("memorySync.upToDate")}
            </span>}
            {status.last.commit && (
              <code className="font-mono text-[11px] text-gray-500 dark:text-white/50">
                {status.last.commit.slice(0, 7)}
              </code>
            )}
          </div>
          {!status.last.restored && <p className="m-0 text-[12px] text-gray-500 dark:text-white/50">
            {t("memorySync.counts", {
              pages: status.last.aiMemoryPages,
              entries: status.last.sqliteEntries,
              revisions: status.last.sqliteRevisions,
            })}
          </p>}
          {lastWarning && (
            <p role="alert" className="m-0 text-[12px] font-medium text-amber-700 dark:text-amber-300">
              {t(lastWarning === "unavailable" ? "memorySync.warnUnavailable" : "memorySync.warnEmpty")}
            </p>
          )}
          {status.last.aiMemoryNote && (
            <p className="m-0 text-[12px] text-amber-700 dark:text-amber-300">
              {status.last.aiMemoryNote}
            </p>
          )}
          <p className="m-0 text-[12px] text-gray-600 dark:text-white/60">
            {t("memorySync.restoreCounts", {
              imported: status.last.restore.imported,
              unchanged: status.last.restore.unchanged,
              conflicts: status.last.restore.conflicts.length,
              skipped: status.last.restore.skippedSecrets,
            })}
          </p>
        </div>
      )}

      {status?.last?.restore.conflicts.length ? (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-300/60 bg-amber-50/70 dark:border-amber-400/20 dark:bg-amber-500/[0.06] px-4 py-3">
          <span className="text-[12.5px] font-medium text-amber-900 dark:text-amber-200">
            {t("memorySync.conflictsTitle", { count: status.last.restore.conflicts.length })}
          </span>
          {status.last.restore.conflicts.map((conflict) => (
            <div key={conflict.remotePath} className="flex flex-col gap-2 border-t border-amber-300/40 pt-2 first:border-0 first:pt-0">
              <strong className="text-[12px]">{conflict.title} · <code>{conflict.remotePath}</code></strong>
              <div className="grid gap-2 md:grid-cols-2">
                <div className="min-w-0"><span className="text-[11px] font-medium">{t("memorySync.localVersion")}</span><pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-white/70 dark:bg-black/20 p-2 text-[11px]">{conflict.localBody}</pre></div>
                <div className="min-w-0"><span className="text-[11px] font-medium">{t("memorySync.remoteVersion")}</span><pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-white/70 dark:bg-black/20 p-2 text-[11px]">{conflict.remoteBody}</pre></div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={running} onClick={() => void resolveConflict(workspaceId, activeCwd, conflict.remotePath, false)}>
                  {t("memorySync.keepLocal")}
                </Button>
                <Button size="sm" variant="primary" disabled={running} onClick={() => void resolveConflict(workspaceId, activeCwd, conflict.remotePath, true)}>
                  {t("memorySync.useRemote")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {status?.last && status.last.skippedPages.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-[12.5px] text-amber-900 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <InfoIcon className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
            <span className="font-medium">
              {t("memorySync.skippedTitle", { count: status.last.skippedPages.length })}
            </span>
          </div>
          <ul className="m-0 list-disc pl-6 space-y-1 text-[12px]">
            {status.last.skippedPages.map((page) => (
              <li key={`${page.source}:${page.path}`}>
                <code className="font-mono text-[11px]">{page.path}</code>
                {" — "}
                <span>{page.title}</span>
                {page.reason ? ` (${page.reason})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {visibleError && (
        <div
          role="alert"
          className="rounded-xl bg-rose-50 dark:bg-rose-500/10 px-4 py-3 text-[12.5px] text-rose-700 dark:text-rose-300"
        >
          {visibleError}
        </div>
      )}
    </SettingsSection>
  );
}
