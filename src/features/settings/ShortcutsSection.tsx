import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { getShortcuts, shortcutKeyFromEvent, type Shortcut } from "@/app/shortcuts";
import { contextualRuleRecordingId, isBindingError, parseContextualRuleRecordingId, shortcutBindingKey, useShortcutPreferences, validateShortcutBinding, type ShortcutBinding } from "@/app/shortcutPrefs";
import { shortcutWhensOverlap, validateShortcutWhen, type ShortcutWhenError } from "@/app/shortcutWhen";
import { shortcutMatches } from "@/app/shortcutSearch";
import { activeProjectScriptCwd } from "@/features/chat/projectScriptContext";
import { loadChatProjectScripts } from "@/features/chat/projectScripts";
import { useChatPrefs } from "@/features/chat/chatPrefs";
import { useChatStore } from "@/features/chat/store";
import { useStructured } from "@/features/chat/structured/store";
import { useTabsStore } from "@/features/tabs/store";
import { useUiStore } from "@/app/uiStore";
import { SearchIcon } from "@/features/chat/chatIcons";
import { SettingsSection } from "@/features/settings/SettingsSection";

/** Cada tecla en su propia caja, como se dibuja una tecla. */
function Chord({ display }: { display: string }) {
  const keys = display.endsWith("++") ? [...display.slice(0, -2).split("+"), "+"] : display.split("+");
  return (
    <span className="flex items-center gap-1 shrink-0">
      {keys.map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          className="min-w-5 h-5 px-1.5 rounded-[5px] inline-flex items-center justify-center
            font-mono text-[11px] leading-none tabular-nums
            bg-white dark:bg-surface-overlay
            text-gray-700 dark:text-gray-200
            shadow-[inset_0_-1px_0_rgba(0,0,0,0.2)] dark:shadow-[inset_0_-1px_0_rgba(0,0,0,0.45),0_0_0_0.5px_rgba(255,255,255,0.08)]"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

/** Lista pesquisável de atalhos globais; combinações podem ser regravadas localmente. */
export function ShortcutsSection() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [conditionDrafts, setConditionDrafts] = useState<Record<string, string>>({});
  const [conditionErrors, setConditionErrors] = useState<Record<string, ShortcutWhenError | "conflict" | "contextRequired" | undefined>>({});
  const [expandedConditions, setExpandedConditions] = useState<Record<string, boolean>>({});
  const bindings = useShortcutPreferences((state) => state.bindings);
  const conditions = useShortcutPreferences((state) => state.conditions);
  const contextualRules = useShortcutPreferences((state) => state.contextualRules);
  const recordingId = useShortcutPreferences((state) => state.recordingId);
  const setRecordingId = useShortcutPreferences((state) => state.setRecordingId);
  const setBinding = useShortcutPreferences((state) => state.setBinding);
  const setCondition = useShortcutPreferences((state) => state.setCondition);
  const addContextualRule = useShortcutPreferences((state) => state.addContextualRule);
  const setContextualRuleBinding = useShortcutPreferences((state) => state.setContextualRuleBinding);
  const setContextualRuleWhen = useShortcutPreferences((state) => state.setContextualRuleWhen);
  const removeContextualRule = useShortcutPreferences((state) => state.removeContextualRule);
  const resetBinding = useShortcutPreferences((state) => state.resetBinding);
  const resetAll = useShortcutPreferences((state) => state.resetAll);
  // O registro dinâmico acompanha o projeto visível sem misturar ações de outros workspaces.
  const chatMode = useUiStore((state) => state.chatMode);
  const shellMode = useUiStore((state) => state.shellMode);
  const chatThread = useChatStore((state) => state.thread);
  const chatComposing = useChatStore((state) => state.composing);
  const composeFolder = useChatStore((state) => state.composeFolder);
  const structuredThreads = useStructured((state) => state.threads);
  const tabs = useTabsStore((state) => state.tabs);
  const activeTabId = useTabsStore((state) => state.activeTabId);
  const chatPrefs = useChatPrefs();
  const projectCwd = activeProjectScriptCwd();
  const projectScripts = useMemo(() => loadChatProjectScripts(projectCwd), [projectCwd]);
  const allShortcuts = useMemo(() => getShortcuts({ cwd: projectCwd, scripts: projectScripts }), [
    bindings, conditions, contextualRules, projectCwd, projectScripts, chatMode, shellMode,
    chatThread, chatComposing, composeFolder, structuredThreads, tabs, activeTabId, chatPrefs,
  ]);
  const shortcuts = useMemo(() => allShortcuts.filter((shortcut) => !shortcut.ruleId), [allShortcuts]);
  const entries = [
    ...shortcuts.map((shortcut) => ({
      id: shortcut.id,
      label: t(shortcut.labelKey, shortcut.labelName ? { name: shortcut.labelName, project: shortcut.labelProject } : undefined),
      display: shortcut.display || t("settings.shortcuts.unbound"),
      condition: shortcut.when ?? "",
      rules: contextualRules[shortcut.id] ?? [],
      enabled: shortcut.enabled !== false,
      configurable: true,
      shortcut,
    })),
  ].filter((entry) => shortcutMatches(entry.label, `${entry.id} ${entry.display} ${entry.condition} ${entry.rules.map((rule) => rule.when).join(" ")}`, query));

  useEffect(() => {
    if (!recordingId) return;
    const capture = (event: KeyboardEvent) => {
      const key = shortcutKeyFromEvent(event);
      if (key.toLowerCase() === "escape" && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setRecordingId(null);
        setRecordingError(null);
        return;
      }
      if (["shift", "control", "alt", "meta", "os"].includes(key.toLowerCase())) return;
      event.preventDefault();
      event.stopImmediatePropagation();

      // Backspace/Delete sem modificador deixa a ação sem atalho; Escape cancela a gravação.
      if (["backspace", "delete"].includes(key.toLowerCase()) && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        const targetRule = parseContextualRuleRecordingId(recordingId);
        if (targetRule) setContextualRuleBinding(targetRule.actionId, targetRule.ruleId, null);
        else setBinding(recordingId, null);
        setRecordingError(null);
        return;
      }

      const candidate = validateShortcutBinding({
        key, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey,
      });
      if (isBindingError(candidate)) {
        setRecordingError(`settings.shortcuts.invalid.${candidate}`);
        return;
      }
      const targetRule = parseContextualRuleRecordingId(recordingId);
      const targetCondition = targetRule
        ? useShortcutPreferences.getState().contextualRules[targetRule.actionId]?.find((rule) => rule.id === targetRule.ruleId)?.when ?? ""
        : useShortcutPreferences.getState().conditions[recordingId] ?? "";
      const conflict = targetRule && !targetCondition.trim() ? undefined : allShortcuts.find((shortcut) => {
        if (shortcut.enabled === false || !shortcut.key) return false;
        if (targetRule ? shortcut.ruleId === targetRule.ruleId : shortcut.id === recordingId) return false;
        return shortcutBindingKey(bindingOf(shortcut)) === shortcutBindingKey(candidate)
          && shortcutWhensOverlap(shortcut.when, targetCondition);
      });
      if (conflict) {
        setRecordingError("settings.shortcuts.conflict");
        return;
      }
      if (targetRule) setContextualRuleBinding(targetRule.actionId, targetRule.ruleId, candidate);
      else setBinding(recordingId, candidate);
      setRecordingError(null);
    };
    window.addEventListener("keydown", capture, true);
    return () => {
      window.removeEventListener("keydown", capture, true);
      if (useShortcutPreferences.getState().recordingId === recordingId) setRecordingId(null);
    };
  }, [recordingId, setBinding, setRecordingId, shortcuts]);

  return (
    <SettingsSection title={t("settings.shortcuts")} description={t("settings.shortcuts.desc")}>
      <label className="flex items-center gap-2 px-3 h-9 rounded-lg border border-gray-200 dark:border-white/10
        bg-white dark:bg-white/[0.03] text-gray-400 dark:text-white/40 focus-within:border-accent-500/60">
        <SearchIcon className="w-4 h-4 shrink-0" />
        <input value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={t("settings.shortcuts.search")} aria-label={t("settings.shortcuts.search")}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-white/35 outline-none" />
      </label>
      {(Object.keys(bindings).length > 0 || Object.keys(conditions).length > 0 || Object.keys(contextualRules).length > 0) && <button type="button" onClick={() => {
        resetAll();
        setConditionDrafts({});
        setConditionErrors({});
        setExpandedConditions({});
        setRecordingError(null);
      }}
        className="self-end h-7 px-2.5 rounded-md text-[12px] text-gray-600 dark:text-white/65 hover:bg-gray-100 dark:hover:bg-white/[0.07]">
        {t("settings.shortcuts.resetAll")}
      </button>}
      <ul className="flex flex-col overflow-hidden rounded-xl
        bg-gray-100/70 dark:bg-surface-raised/60
        divide-y divide-gray-200 dark:divide-white/[0.08]">
        {entries.map((entry) => (
          <li key={entry.id} className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
              <span title={entry.label} className="text-[13px] text-gray-900 dark:text-gray-100 min-w-0 truncate">
                {entry.label}
              </span>
              <span className="text-[10px] leading-4 font-mono text-gray-500 dark:text-white/40">
                {t("settings.shortcuts.commandId", { id: entry.id })}
              </span>
              {entry.configurable && <>
                <button type="button"
                  aria-expanded={Boolean(expandedConditions[entry.id] ?? conditions[entry.id] ?? entry.rules.length)}
                  onClick={() => setExpandedConditions((current) => ({ ...current, [entry.id]: !Boolean(current[entry.id] ?? conditions[entry.id] ?? entry.rules.length) }))}
                  className="text-[11px] text-gray-500 dark:text-white/45 hover:text-gray-800 dark:hover:text-white/75">
                  {conditions[entry.id] || entry.rules.length ? t("settings.shortcuts.whenActive") : t("settings.shortcuts.whenToggle")}
                </button>
                {Boolean(expandedConditions[entry.id] ?? Boolean(conditions[entry.id] || entry.rules.length)) && <div className="w-full max-w-lg flex flex-col gap-1">
                  <input
                    type="text"
                    maxLength={256}
                    value={conditionDrafts[entry.id] ?? conditions[entry.id] ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      setConditionDrafts((current) => ({ ...current, [entry.id]: value }));
                      setConditionErrors((current) => ({ ...current, [entry.id]: undefined }));
                    }}
                    onBlur={() => {
                      const value = conditionDrafts[entry.id] ?? conditions[entry.id] ?? "";
                      const checked = validateShortcutWhen(value);
                      if (!checked.ok) {
                        setConditionErrors((current) => ({ ...current, [entry.id]: checked.error }));
                        return;
                      }
                      const binding = entry.shortcut && entry.shortcut.enabled !== false && entry.shortcut.key
                        ? bindingOf(entry.shortcut)
                        : null;
                      if (binding && hasContextualConflict(allShortcuts, entry.id, null, binding, checked.value)) {
                        setConditionErrors((current) => ({ ...current, [entry.id]: "conflict" }));
                        return;
                      }
                      setCondition(entry.id, checked.value);
                      setConditionErrors((current) => ({ ...current, [entry.id]: undefined }));
                    }}
                    aria-label={t("settings.shortcuts.whenLabel", { shortcut: entry.label })}
                    placeholder={t("settings.shortcuts.whenPlaceholder")}
                    aria-invalid={Boolean(conditionErrors[entry.id])}
                    className="h-7 w-full rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.03] px-2 text-[11px] font-mono text-gray-800 dark:text-gray-200 placeholder:font-sans placeholder:text-gray-400 dark:placeholder:text-white/35 outline-none focus:border-accent-500/60"
                  />
                  <span className={`text-[10px] leading-4 ${conditionErrors[entry.id] ? "text-red-600 dark:text-red-400" : "text-gray-400 dark:text-white/35"}`} role={conditionErrors[entry.id] ? "alert" : undefined}>
                    {conditionErrors[entry.id]
                      ? t(`settings.shortcuts.whenError.${conditionErrors[entry.id]}`)
                      : t("settings.shortcuts.whenHint")}
                  </span>
                  <div className="flex flex-col gap-2 pt-2">
                    {entry.rules.map((rule, index) => {
                      const ruleKey = `${entry.id}:${rule.id}`;
                      const ruleRecordingId = contextualRuleRecordingId(entry.id, rule.id);
                      return <div key={rule.id} className="flex flex-col gap-1.5 rounded-lg border border-gray-200 dark:border-white/10 p-2">
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 text-[10px] text-gray-500 dark:text-white/45">
                            {t("settings.shortcuts.contextRule", { number: index + 1 })}
                          </span>
                          <button type="button" onClick={() => { setRecordingError(null); setRecordingId(ruleRecordingId); }}
                            aria-label={t("settings.shortcuts.changeContextRule", { shortcut: entry.label, number: index + 1 })}
                            className={`min-h-7 px-2 rounded-md border ${recordingId === ruleRecordingId ? "border-accent-500 bg-accent-500/10 text-accent-700 dark:text-accent-300" : "border-transparent hover:border-gray-300 dark:hover:border-white/15"}`}>
                            {recordingId === ruleRecordingId
                              ? <span className="text-[11px]">{t("settings.shortcuts.recording")}</span>
                              : rule.binding ? <Chord display={displayBinding(rule.binding)} /> : <span className="text-[11px] text-gray-500 dark:text-white/50">{t("settings.shortcuts.unbound")}</span>}
                          </button>
                          <button type="button" onClick={() => {
                            removeContextualRule(entry.id, rule.id);
                            setConditionDrafts((current) => { const next = { ...current }; delete next[ruleKey]; return next; });
                            setConditionErrors((current) => { const next = { ...current }; delete next[ruleKey]; return next; });
                            if (recordingId === ruleRecordingId) setRecordingError(null);
                          }}
                            aria-label={t("settings.shortcuts.removeContextRule", { shortcut: entry.label, number: index + 1 })}
                            className="h-7 px-2 rounded-md text-[11px] text-gray-500 dark:text-white/45 hover:bg-gray-200 dark:hover:bg-white/10">
                            {t("settings.shortcuts.remove")}
                          </button>
                        </div>
                        <input
                          type="text"
                          maxLength={256}
                          value={conditionDrafts[ruleKey] ?? rule.when}
                          onChange={(event) => {
                            const value = event.target.value;
                            setConditionDrafts((current) => ({ ...current, [ruleKey]: value }));
                            setConditionErrors((current) => ({ ...current, [ruleKey]: undefined }));
                          }}
                          onBlur={() => {
                            const value = conditionDrafts[ruleKey] ?? rule.when;
                            const checked = validateShortcutWhen(value);
                            if (!checked.ok) {
                              setConditionErrors((current) => ({ ...current, [ruleKey]: checked.error }));
                              return;
                            }
                            if (!checked.value) {
                              setConditionErrors((current) => ({ ...current, [ruleKey]: "contextRequired" }));
                              return;
                            }
                            if (rule.binding && hasContextualConflict(allShortcuts, entry.id, rule.id, rule.binding, checked.value)) {
                              setConditionErrors((current) => ({ ...current, [ruleKey]: "conflict" }));
                              return;
                            }
                            setContextualRuleWhen(entry.id, rule.id, checked.value);
                            setConditionErrors((current) => ({ ...current, [ruleKey]: undefined }));
                          }}
                          aria-label={t("settings.shortcuts.whenLabel", { shortcut: `${entry.label} · ${index + 1}` })}
                          placeholder={t("settings.shortcuts.whenPlaceholder")}
                          aria-invalid={Boolean(conditionErrors[ruleKey])}
                          className="h-7 w-full rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.03] px-2 text-[11px] font-mono text-gray-800 dark:text-gray-200 placeholder:font-sans placeholder:text-gray-400 dark:placeholder:text-white/35 outline-none focus:border-accent-500/60"
                        />
                        <span className={`text-[10px] leading-4 ${conditionErrors[ruleKey] ? "text-red-600 dark:text-red-400" : "text-gray-400 dark:text-white/35"}`} role={conditionErrors[ruleKey] ? "alert" : undefined}>
                          {conditionErrors[ruleKey]
                            ? t(`settings.shortcuts.whenError.${conditionErrors[ruleKey]}`)
                            : t("settings.shortcuts.contextRuleHint")}
                        </span>
                        {recordingId === ruleRecordingId && recordingError && <span role="status" className="max-w-48 text-[11px] text-red-600 dark:text-red-400">{t(recordingError)}</span>}
                      </div>;
                    })}
                    <button type="button" disabled={entry.rules.length >= 20} onClick={() => {
                      addContextualRule(entry.id, crypto.randomUUID());
                      setExpandedConditions((current) => ({ ...current, [entry.id]: true }));
                    }}
                      className="self-start h-7 px-2 rounded-md text-[11px] text-gray-600 dark:text-white/60 hover:bg-gray-100 dark:hover:bg-white/[0.07] disabled:opacity-40">
                      {t("settings.shortcuts.addContextRule")}
                    </button>
                  </div>
                </div>}
              </>}
            </div>
            <div className="flex items-center gap-2 self-end sm:self-auto">
              {entry.configurable && entry.shortcut ? <>
                <button type="button" onClick={() => { setRecordingError(null); setRecordingId(entry.id); }}
                  aria-label={recordingId === entry.id ? t("settings.shortcuts.recording") : t("settings.shortcuts.change", { shortcut: entry.label })}
                  className={`min-h-8 px-2 rounded-md border ${recordingId === entry.id ? "border-accent-500 bg-accent-500/10 text-accent-700 dark:text-accent-300" : "border-transparent hover:border-gray-300 dark:hover:border-white/15"}`}>
                  {recordingId === entry.id
                    ? <span className="text-[12px]">{t("settings.shortcuts.recording")}</span>
                    : entry.enabled ? <Chord display={entry.display} /> : <span className="text-[12px] text-gray-500 dark:text-white/50">{entry.display}</span>}
                </button>
                {(Object.prototype.hasOwnProperty.call(bindings, entry.id) || Object.prototype.hasOwnProperty.call(conditions, entry.id) || Object.prototype.hasOwnProperty.call(contextualRules, entry.id)) && <button type="button" onClick={() => {
                  resetBinding(entry.id);
                  setConditionDrafts((current) => { const next = { ...current }; delete next[entry.id]; return next; });
                  setConditionErrors((current) => ({ ...current, [entry.id]: undefined }));
                  setExpandedConditions((current) => ({ ...current, [entry.id]: false }));
                  setRecordingError(null);
                }}
                  aria-label={t("settings.shortcuts.reset")} title={t("settings.shortcuts.reset")}
                  className="h-7 px-2 rounded-md text-[11px] text-gray-500 dark:text-white/45 hover:bg-gray-200 dark:hover:bg-white/10">
                  {t("settings.shortcuts.reset")}
                </button>}
                {recordingId === entry.id && recordingError && <span role="status" className="max-w-48 text-[11px] text-red-600 dark:text-red-400">{t(recordingError)}</span>}
              </> : <Chord display={entry.display} />}
            </div>
          </li>
        ))}
        {entries.length === 0 && <li role="status" className="px-4 py-3.5 text-[13px] text-gray-500 dark:text-white/50">
          {t("settings.shortcuts.noResults")}
        </li>}
      </ul>

      {/* Explicita quais teclas globais deixam de chegar aos agentes no terminal. */}
      <p className="px-3 py-2.5 rounded-xl text-[12px] leading-4
        bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300">
        {t("settings.shortcuts.terminalNote")} {t("settings.shortcuts.customNote")}
      </p>
    </SettingsSection>
  );
}

function bindingOf(shortcut: Shortcut): ShortcutBinding {
  return {
    key: shortcut.key,
    ctrl: shortcut.ctrl ?? true,
    shift: Boolean(shortcut.shift),
    alt: Boolean(shortcut.alt),
    meta: Boolean(shortcut.meta),
  };
}

function displayBinding(binding: ShortcutBinding): string {
  return [
    binding.meta ? "Meta" : null,
    binding.ctrl ? "Ctrl" : null,
    binding.alt ? "Alt" : null,
    binding.shift ? "Shift" : null,
    binding.key.length === 1 ? binding.key.toUpperCase() : binding.key,
  ].filter((value): value is string => Boolean(value)).join("+");
}

function hasContextualConflict(shortcuts: ReturnType<typeof getShortcuts>, actionId: string, ruleId: string | null, binding: ShortcutBinding, when: string): boolean {
  return shortcuts.some((shortcut) => {
    if (!shortcut.key) return false;
    if (ruleId ? shortcut.actionId === actionId && shortcut.ruleId === ruleId : shortcut.id === actionId) return false;
    return shortcutBindingKey(bindingOf(shortcut)) === shortcutBindingKey(binding)
      && shortcutWhensOverlap(shortcut.when, when);
  });
}
