/**
 * A importação de cookies de um perfil do Firefox, em Configurações → Geral → Preferências, logo
 * abaixo da busca do navegador. Fluxo explícito: escolher o perfil, revisar os domínios, marcar,
 * confirmar. Só o backend (`preview/importer`) lê o perfil; aqui chegam domínios e contagens.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PopupSelect } from "@/shared/ui/PopupSelect";
import { SettingsGroup, SettingsSection } from "@/features/settings/SettingsSection";

import { asFailure, canImport, failureKey, selectAll, selectedInOrder, toggleDomain } from "./browserImportModel";
import {
  browserImportApply,
  browserImportProfiles,
  browserImportReview,
  type BrowserImportFailure,
  type BrowserImportOutcome,
  type BrowserImportProfile,
  type BrowserImportReview,
} from "./ipc";

type Phase = "idle" | "choosing" | "reviewing" | "done";

const PRIMARY =
  "cc-t h-9 shrink-0 rounded-lg bg-accent-600 px-3 text-sm font-medium text-white hover:bg-accent-500 disabled:opacity-45";
const SECONDARY =
  "cc-t h-9 shrink-0 rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-45 dark:border-white/15 dark:text-white/80 dark:hover:bg-white/[0.06]";
const HINT = "m-0 text-[12px] leading-4 text-gray-500 dark:text-white/45";

export function BrowserImportSetting() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("idle");
  const [profiles, setProfiles] = useState<BrowserImportProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [review, setReview] = useState<BrowserImportReview | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [outcome, setOutcome] = useState<BrowserImportOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<BrowserImportFailure | null>(null);

  /** Uma chamada ao backend: liga o indicador, mostra a recusa se falhar e desliga ao terminar. */
  const run = <T,>(call: () => Promise<T>, onDone: (value: T) => void) => {
    setBusy(true);
    setFailure(null);
    call()
      .then(onDone)
      .catch((reason: unknown) => setFailure(asFailure(reason)))
      .finally(() => setBusy(false));
  };

  const reset = () => {
    setPhase("idle");
    setProfiles([]);
    setProfileId("");
    setReview(null);
    setSelected(new Set<string>());
    setOutcome(null);
    setFailure(null);
  };

  const start = () =>
    run(browserImportProfiles, (list) => {
      setProfiles(list);
      setProfileId(list[0]?.id ?? "");
      setPhase("choosing");
    });

  const reviewProfile = () =>
    run(
      () => browserImportReview(profileId),
      (value) => {
        setReview(value);
        setSelected(new Set<string>());
        setPhase("reviewing");
      },
    );

  const apply = () => {
    if (!review) return;
    const domains = selectedInOrder(review.domains, selected);
    if (!canImport(new Set(domains))) return;
    run(
      () => browserImportApply(profileId, domains),
      (value) => {
        setOutcome(value);
        setPhase("done");
      },
    );
  };

  return (
    <SettingsSection title={t("settings.browserImport.title")} description={t("settings.browserImport.description")}>
      <SettingsGroup>
        <div className="flex flex-col gap-3 px-4 py-3.5">
          {busy && (
            <p role="status" aria-live="polite" className={HINT}>
              {t("settings.browserImport.reading")}
            </p>
          )}

          {phase === "idle" && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={start} disabled={busy} className={PRIMARY}>
                  {t("settings.browserImport.start")}
                </button>
              </div>
              <p className={HINT}>{t("settings.browserImport.onlyFirefox")}</p>
            </div>
          )}

          {phase === "choosing" && (
            <div className="flex flex-col gap-3">
              {profiles.length === 0 ? (
                <p className={HINT}>{t("settings.browserImport.noProfiles")}</p>
              ) : (
                <>
                  <PopupSelect
                    value={profileId}
                    aria-label={t("settings.browserImport.profile")}
                    onChange={(event) => setProfileId(event.target.value)}
                  >
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </PopupSelect>
                  <p className={HINT}>{t("settings.browserImport.closeFirst")}</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={reviewProfile} disabled={busy || profileId === ""} className={PRIMARY}>
                      {t("settings.browserImport.review")}
                    </button>
                  </div>
                </>
              )}
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={reset} className={SECONDARY}>
                  {t("settings.browserImport.cancel")}
                </button>
              </div>
            </div>
          )}

          {phase === "reviewing" && review && (
            <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
              <legend className="mb-1 text-[13px] font-medium text-gray-900 dark:text-white">
                {t("settings.browserImport.reviewTitle")}
              </legend>
              <p className={HINT}>{t("settings.browserImport.reviewHint")}</p>
              {review.domains.length === 0 ? (
                <p className={HINT}>{t("settings.browserImport.noDomainsFound")}</p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setSelected(selectAll(review.domains))} className={SECONDARY}>
                      {t("settings.browserImport.selectAll")}
                    </button>
                    <button type="button" onClick={() => setSelected(new Set<string>())} className={SECONDARY}>
                      {t("settings.browserImport.clearAll")}
                    </button>
                  </div>
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {review.domains.map((entry) => {
                      const id = `browser-import-${entry.domain}`;
                      return (
                        <li key={entry.domain}>
                          <label
                            htmlFor={id}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
                          >
                            <input
                              id={id}
                              type="checkbox"
                              checked={selected.has(entry.domain)}
                              onChange={() => setSelected((prev) => toggleDomain(prev, entry.domain))}
                              className="h-4 w-4 accent-accent-600"
                            />
                            <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-gray-900 dark:text-white">
                              {entry.domain}
                            </span>
                            <span className="text-[12px] text-gray-500 dark:text-white/50">
                              {t("settings.browserImport.cookies", { count: entry.cookies })}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
              {review.ignored > 0 && (
                <p className={HINT}>{t("settings.browserImport.ignored", { count: review.ignored })}</p>
              )}
              <p className={HINT}>{t("settings.browserImport.oneTimeCopy")}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={apply} disabled={busy || !canImport(selected)} className={PRIMARY}>
                  {t("settings.browserImport.apply", { count: selected.size })}
                </button>
                <button type="button" onClick={reset} className={SECONDARY}>
                  {t("settings.browserImport.cancel")}
                </button>
              </div>
            </fieldset>
          )}

          {phase === "done" && outcome && (
            <div className="flex flex-col gap-2">
              <p role="status" className="m-0 text-[13px] text-gray-900 dark:text-white">
                {t("settings.browserImport.done")}
              </p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {outcome.domains.map((entry) => (
                  <li key={entry.domain} className="flex items-center gap-2 text-[13px] text-gray-700 dark:text-white/75">
                    <span className="font-mono">{entry.domain}</span>
                    <span className="text-[12px] text-gray-500 dark:text-white/50">
                      {t("settings.browserImport.cookies", { count: entry.cookies })}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={reset} className={SECONDARY}>
                  {t("settings.browserImport.close")}
                </button>
              </div>
            </div>
          )}

          {failure && (
            <p role="alert" className="m-0 text-[12px] leading-4 text-red-600 dark:text-red-400">
              {t(failureKey(failure.code))}
              {failure.detail && <span className="block text-gray-500 dark:text-white/45">{failure.detail}</span>}
            </p>
          )}
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}
