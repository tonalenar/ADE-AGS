/**
 * A importação de cookies de outro navegador (Chrome, Edge, Brave, Arc, Vivaldi, Opera, Helium, Safari, Firefox,
 * Zen), em Configurações → Navegador. Fluxo explícito, só por clique: escolher o navegador, o perfil de origem e o
 * perfil de destino da ADE, revisar os domínios, marcar, confirmar. Só o backend (`preview/importer`) lê o
 * perfil; aqui chegam domínios e contagens. A chave do Chromium só é lida ao confirmar a gravação.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PopupSelect } from "@/shared/ui/PopupSelect";
import { SettingsGroup, SettingsSection } from "@/features/settings/SettingsSection";

import {
  asFailure,
  canImport,
  defaultSourceId,
  failureKey,
  keepProfileId,
  listedSources,
  needsKeyPrompt,
  selectAll,
  selectedInOrder,
  sourceStep,
  toggleDomain,
  unavailableKey,
} from "./browserImportModel";
import {
  browserImportApply,
  browserImportOpenFullDiskAccess,
  browserImportReview,
  browserImportSources,
  type BrowserImportFailure,
  type BrowserImportOutcome,
  type BrowserImportReview,
  type BrowserImportSource,
} from "./ipc";
import { DEFAULT_BROWSER_PROFILE_ID, readBrowserProfiles } from "./profiles";

type Phase = "idle" | "choosing" | "reviewing" | "done";

const PRIMARY =
  "cc-t h-9 shrink-0 rounded-lg bg-accent-600 px-3 text-sm font-medium text-white hover:bg-accent-500 disabled:opacity-45";
const SECONDARY =
  "cc-t h-9 shrink-0 rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-45 dark:border-white/15 dark:text-white/80 dark:hover:bg-white/[0.06]";
const HINT = "m-0 text-[12px] leading-4 text-gray-500 dark:text-white/45";
/** Falhas que se resolvem fora do app (fechar o navegador, dar a permissão): voltam ao passo de escolha. */
const RECHECK_CODES = new Set(["browser-running", "needs-full-disk-access"]);

export function BrowserImportSetting() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("idle");
  const [sources, setSources] = useState<BrowserImportSource[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [targetId, setTargetId] = useState(DEFAULT_BROWSER_PROFILE_ID);
  const [review, setReview] = useState<BrowserImportReview | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [outcome, setOutcome] = useState<BrowserImportOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<BrowserImportFailure | null>(null);

  const source = sources.find((candidate) => candidate.id === sourceId);
  const step = source ? sourceStep(source) : "blocked";
  const targets = readBrowserProfiles();
  const targetName = (id: string) =>
    id === DEFAULT_BROWSER_PROFILE_ID ? t("browser.profile.default") : (targets.find((p) => p.id === id)?.name ?? id);

  /** Uma chamada ao backend: liga o indicador, mostra a recusa se falhar e desliga ao terminar. */
  const run = <T,>(call: () => Promise<T>, onDone: (value: T) => void, onFail?: (failure: BrowserImportFailure) => void) => {
    setBusy(true);
    setFailure(null);
    call()
      .then(onDone)
      .catch((reason: unknown) => {
        const next = asFailure(reason);
        setFailure(next);
        onFail?.(next);
      })
      .finally(() => setBusy(false));
  };

  const reset = () => {
    setPhase("idle");
    setSources([]);
    setSourceId("");
    setProfileId("");
    setTargetId(DEFAULT_BROWSER_PROFILE_ID);
    setReview(null);
    setSelected(new Set<string>());
    setOutcome(null);
    setFailure(null);
  };

  /** Lê a lista de novo (o navegador foi fechado, a permissão foi dada) mantendo a escolha, se ainda vale. */
  const refresh = (keepFailure = false) => {
    setBusy(true);
    if (!keepFailure) setFailure(null);
    browserImportSources()
      .then((all) => {
        const list = listedSources(all);
        const keepId = list.some((item) => item.id === sourceId) ? sourceId : defaultSourceId(list);
        setSources(list);
        setSourceId(keepId);
        setProfileId(keepProfileId(list.find((item) => item.id === keepId), profileId));
        setPhase("choosing");
      })
      .catch((reason: unknown) => setFailure(asFailure(reason)))
      .finally(() => setBusy(false));
  };

  const chooseSource = (id: string) => {
    setSourceId(id);
    setProfileId(keepProfileId(sources.find((item) => item.id === id), ""));
    setFailure(null);
  };

  const reviewProfile = () =>
    run(
      () => browserImportReview(sourceId, profileId),
      (value) => {
        setReview(value);
        setSelected(new Set<string>());
        setPhase("reviewing");
      },
      (next) => RECHECK_CODES.has(next.code) && refresh(true),
    );

  const apply = () => {
    if (!review) return;
    const domains = selectedInOrder(review.domains, selected);
    if (!canImport(new Set(domains))) return;
    run(
      () => browserImportApply(sourceId, profileId, domains, targetId),
      (value) => {
        setOutcome(value);
        setPhase("done");
      },
      (next) => RECHECK_CODES.has(next.code) && refresh(true),
    );
  };

  const openFullDiskAccess = () =>
    browserImportOpenFullDiskAccess().catch((reason: unknown) => setFailure(asFailure(reason)));

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
                <button type="button" onClick={() => refresh()} disabled={busy} className={PRIMARY}>
                  {t("settings.browserImport.start")}
                </button>
              </div>
              <p className={HINT}>{t("settings.browserImport.intro")}</p>
            </div>
          )}

          {phase === "choosing" && (
            <div className="flex flex-col gap-3">
              {sources.length === 0 ? (
                <p className={HINT}>{t("settings.browserImport.noSources")}</p>
              ) : (
                <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
                  <legend className="mb-1 text-[13px] font-medium text-gray-900 dark:text-white">
                    {t("settings.browserImport.chooseBrowser")}
                  </legend>
                  {sources.map((item) => {
                    const id = `browser-import-source-${item.id}`;
                    const itemStep = sourceStep(item);
                    return (
                      <label
                        key={item.id}
                        htmlFor={id}
                        className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${itemStep === "blocked" ? "opacity-60" : "cursor-pointer hover:bg-gray-100 dark:hover:bg-white/[0.06]"}`}
                      >
                        <input
                          id={id}
                          type="radio"
                          name="browser-import-source"
                          value={item.id}
                          checked={sourceId === item.id}
                          disabled={itemStep === "blocked"}
                          onChange={() => chooseSource(item.id)}
                          className="mt-0.5 h-4 w-4 accent-accent-600"
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className="text-[13px] text-gray-900 dark:text-white">{item.name}</span>
                          {item.unavailable && (
                            <span className="text-[12px] text-gray-500 dark:text-white/50">{t(unavailableKey(item.unavailable))}</span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              )}

              {source && step === "configure" && (
                <div className="flex flex-col gap-3">
                  <PopupSelect
                    value={profileId}
                    aria-label={t("settings.browserImport.profile", { browser: source.name })}
                    onChange={(event) => setProfileId(event.target.value)}
                  >
                    {source.profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </PopupSelect>
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] text-gray-500 dark:text-white/50">{t("settings.browserImport.target")}</span>
                    <PopupSelect
                      value={targetId}
                      aria-label={t("settings.browserImport.target")}
                      onChange={(event) => setTargetId(event.target.value)}
                    >
                      {targets.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {targetName(profile.id)}
                        </option>
                      ))}
                    </PopupSelect>
                  </label>
                  <p className={HINT}>{t("settings.browserImport.closeFirst")}</p>
                  {needsKeyPrompt(source) && <p className={HINT}>{t("settings.browserImport.keychainNote")}</p>}
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={reviewProfile} disabled={busy || profileId === ""} className={PRIMARY}>
                      {t("settings.browserImport.review")}
                    </button>
                  </div>
                </div>
              )}

              {source && step === "quit" && (
                <div className="flex flex-col gap-2">
                  <p className={HINT}>{t("settings.browserImport.quitStep", { browser: source.name })}</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => refresh()} disabled={busy} className={PRIMARY}>
                      {t("settings.browserImport.recheck")}
                    </button>
                  </div>
                </div>
              )}

              {source && step === "fullDiskAccess" && (
                <div className="flex flex-col gap-2">
                  <p className={HINT}>{t("settings.browserImport.fullDiskAccessStep")}</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={openFullDiskAccess} className={PRIMARY}>
                      {t("settings.browserImport.openSettings")}
                    </button>
                    <button type="button" onClick={() => refresh()} disabled={busy} className={SECONDARY}>
                      {t("settings.browserImport.recheck")}
                    </button>
                  </div>
                </div>
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
              <p className={HINT}>{t("settings.browserImport.oneTimeCopy", { target: targetName(targetId) })}</p>
              {source && needsKeyPrompt(source) && <p className={HINT}>{t("settings.browserImport.keychainNote")}</p>}
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
                {t("settings.browserImport.done", { target: targetName(targetId) })}
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
              {outcome.skipped > 0 && <p className={HINT}>{t("settings.browserImport.skipped", { count: outcome.skipped })}</p>}
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
