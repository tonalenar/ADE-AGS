import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAvailableAgents } from "@/features/agents/useAvailableAgents";
import {
  chatLimitResumePrefGet,
  chatLimitResumePrefSet,
  chatTitleSettingsGet,
  chatTitleSettingsSet,
  chatTitleWriters,
  type TitleSettingsDto,
} from "@/features/chat/threadTextIpc";
import { PopupSelect } from "@/shared/ui/PopupSelect";
import { SettingsGroup, SettingsRow, SettingsSection, SettingsToggleRow } from "@/features/settings/SettingsSection";

/** O teto que o backend aceita para as instruções do título (`MAX_INSTRUCTIONS_CHARS`). */
export const MAX_TITLE_INSTRUCTIONS = 600;

const inputClass = `rounded-lg border border-gray-200 bg-white px-2.5 text-[13px] text-gray-900 focus:outline-none
  focus-visible:ring-2 focus-visible:ring-accent-500/40 disabled:opacity-50 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-white`;

/**
 * Configurações → Threads → texto gerado: o título da conversa escrito por um modelo e a retomada depois do limite de
 * uso. Os dois são locais: o título usa o agente que a conversa já usa (uma chamada curta, somente leitura), e a
 * retomada reagenda a conversa para a hora de renovação que o próprio agente informou. Nada abre rede nova.
 * Os dois vêm desligados: cada título gasta uma chamada do agente, e retomar sozinho gasta o limite que renovou.
 */
export function ThreadsTextSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<TitleSettingsDto | null>(null);
  const [resume, setResume] = useState<boolean | null>(null);
  const [writers, setWriters] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState("");
  const available = useAvailableAgents({ includeLocalAcp: false });
  const labelOf = useMemo(() => new Map(available.map((agent) => [agent.id, agent.label])), [available]);

  useEffect(() => {
    let alive = true;
    chatTitleSettingsGet()
      .then((loaded) => {
        if (!alive) return;
        setSettings(loaded);
        setInstructions(loaded.instructions);
        setModel(loaded.model ?? "");
      })
      .catch(() => alive && setError(t("settings.threads.text.loadError")));
    chatLimitResumePrefGet().then((on) => alive && setResume(on)).catch(() => alive && setError(t("settings.threads.text.loadError")));
    chatTitleWriters().then((ids) => alive && setWriters(ids)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [t]);

  const save = async (next: TitleSettingsDto) => {
    try {
      const saved = await chatTitleSettingsSet(next);
      setSettings(saved);
      setInstructions(saved.instructions);
      setModel(saved.model ?? "");
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  };

  const toggleResume = async (enabled: boolean) => {
    setResume(enabled);
    try {
      await chatLimitResumePrefSet(enabled);
      setError(null);
    } catch {
      setResume(!enabled);
      setError(t("settings.threads.text.saveError"));
    }
  };

  const ready = settings !== null;
  return (
    <>
      <SettingsSection title={t("settings.threads.title.title")} description={t("settings.threads.title.desc")}>
        <SettingsGroup>
          <SettingsToggleRow label={t("settings.threads.title.enable")} description={t("settings.threads.title.enable.hint")}
            checked={settings?.enabled ?? false} disabled={!ready} onChange={(enabled) => settings && void save({ ...settings, enabled })} />
          <div className="flex flex-col gap-2 px-4 py-3.5">
            <label htmlFor="thread-title-instructions" className="text-[14px] font-medium text-gray-900 dark:text-white">
              {t("settings.threads.title.instructions")}
            </label>
            <span className="text-[13px] text-gray-500 dark:text-white/50">{t("settings.threads.title.instructions.hint")}</span>
            <textarea id="thread-title-instructions" rows={3} value={instructions} disabled={!ready} maxLength={MAX_TITLE_INSTRUCTIONS}
              placeholder={t("settings.threads.title.instructions.placeholder")}
              onChange={(e) => setInstructions(e.target.value)}
              onBlur={() => settings && instructions !== settings.instructions && void save({ ...settings, instructions })}
              className={`${inputClass} min-h-[4.5rem] w-full resize-y py-2`} />
            <span className="self-end text-[12px] text-gray-400 dark:text-white/40">{instructions.length}/{MAX_TITLE_INSTRUCTIONS}</span>
          </div>
          <SettingsRow label={t("settings.threads.title.writer")} hint={t("settings.threads.title.writer.hint")}>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <PopupSelect aria-label={t("settings.threads.title.writer")} value={settings?.agentId ?? ""} disabled={!ready}
                onChange={(e) => settings && void save({ ...settings, agentId: e.target.value || null, model: null })}>
                <option value="">{t("settings.threads.title.writer.same")}</option>
                {writers.map((id) => <option key={id} value={id}>{labelOf.get(id) ?? id}</option>)}
              </PopupSelect>
              {settings?.agentId && (
                <input value={model} maxLength={200} aria-label={t("settings.threads.title.model")} placeholder={t("settings.projects.defaults.model.placeholder")}
                  onChange={(e) => setModel(e.target.value)}
                  onBlur={() => settings && (model.trim() || null) !== settings.model && void save({ ...settings, model: model.trim() || null })}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  className={`${inputClass} h-8 w-44`} />
              )}
            </div>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title={t("settings.threads.limit.title")} description={t("settings.threads.limit.desc")}>
        <SettingsGroup>
          <SettingsToggleRow label={t("settings.threads.limit.resume")} description={t("settings.threads.limit.resume.hint")}
            checked={resume ?? false} disabled={resume === null} onChange={(enabled) => void toggleResume(enabled)} />
        </SettingsGroup>
      </SettingsSection>
      {error && <p role="alert" className="m-0 px-1 text-[12.5px] text-red-600 dark:text-red-400">{error}</p>}
    </>
  );
}
