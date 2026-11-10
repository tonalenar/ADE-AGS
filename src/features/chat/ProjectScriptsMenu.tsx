import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShortcutPreferences } from "@/app/shortcutPrefs";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { comparablePath, type BrowserView, type ViewOwner } from "@/features/tabs/viewTabs";

import { usePopover } from "./usePopover";
import { GlobeIcon, PlayIcon, PlusIcon, SettingsIcon, TerminalIcon, WrenchIcon, XIcon } from "./chatIcons";
import { runProjectScript } from "./shellTerminal";
import { setRightPanel, useChatStore } from "./store";
import { projectScriptCommandDelete, projectScriptCommandGet, projectScriptCommandSave } from "./projectScriptsIpc";
import {
  loadChatProjectScripts,
  migrateLegacyChatProjectScripts,
  makeProjectScript,
  newProjectScriptId,
  readT3ProjectScripts,
  saveChatProjectScripts,
  projectScriptCommandContainsSecret,
  normalizeProjectPreviewUrl,
  validProjectScriptCommand,
  type ChatProjectScript,
  type T3ProjectScriptCandidate,
} from "./projectScripts";
import { projectScriptShortcutId } from "./projectScriptContext";

type EditorState = { id: string | null; name: string; command: string; setup: boolean; onSettle: boolean; previewUrl: string };

/** Ações locais do projeto e importação revisável do t3.json. Importar nunca executa comandos. */
export function ProjectScriptsMenu({ cwd, owner = null }: { cwd: string; owner?: ViewOwner | null }) {
  const { t } = useTranslation();
  // O efeito de leitura roda por projeto: o `t` mais novo vale só para a mensagem de erro. Com `t` nas deps,
  // trocar de idioma (ou um `t` novo a cada render) zerava o editor aberto e recarregava tudo em laço.
  const tRef = useRef(t);
  tRef.current = t;
  const { open, setOpen, ref } = usePopover<HTMLSpanElement>();
  const [scripts, setScripts] = useState<ChatProjectScript[]>(() => loadChatProjectScripts(cwd));
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [candidates, setCandidates] = useState<T3ProjectScriptCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [busyImport, setBusyImport] = useState(false);
  const [busySave, setBusySave] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    setScripts(loadChatProjectScripts(cwd));
    setEditor(null);
    setCandidates(null);
    setSelected(new Set());
    setPendingDelete(null);
    setError("");
    void migrateLegacyChatProjectScripts(cwd).then((migrated) => {
      if (current && migrated) setScripts(migrated);
    }).catch((cause) => {
      if (current) {
        setScripts(loadChatProjectScripts(cwd));
        setError(`${tRef.current("chat.projectScripts.legacyMigrationError")} ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    });
    return () => { current = false; };
  }, [cwd]);

  const persist = (next: ChatProjectScript[]): boolean => {
    if (!saveChatProjectScripts(cwd, next)) {
      setError(t("chat.projectScripts.saveError"));
      return false;
    }
    setScripts(next);
    setError("");
    return true;
  };

  const saveEditor = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor) return;
    const previewUrl = editor.previewUrl.trim() ? normalizeProjectPreviewUrl(editor.previewUrl) : undefined;
    if (editor.previewUrl.trim() && !previewUrl) {
      setError(t("chat.projectScripts.previewUrlInvalid"));
      return;
    }
    const id = editor.id ?? newProjectScriptId(editor.name, scripts);
    const script = makeProjectScript(editor.name, id, editor.setup, editor.onSettle, previewUrl ?? undefined);
    if (projectScriptCommandContainsSecret(editor.command)) {
      setError(t("chat.projectScripts.secretInline"));
      return;
    }
    if (!script || !validProjectScriptCommand(editor.command)) {
      setError(t("chat.projectScripts.invalid"));
      return;
    }
    if (!editor.id && scripts.length >= 32) {
      setError(t("chat.projectScripts.limit"));
      return;
    }

    setBusySave(true);
    setError("");
    let previous: string | null = null;
    try {
      if (editor.id) {
        previous = await projectScriptCommandGet(cwd, id);
        if (previous === null) {
          setError(t("chat.projectScripts.commandMissing"));
          return;
        }
      }
      await projectScriptCommandSave(cwd, id, editor.command);
      const next = editor.id
        ? scripts.map((candidate) => candidate.id === editor.id ? script : candidate)
        : [...scripts, script];
      if (persist(next)) setEditor(null);
      else if (previous !== null) await projectScriptCommandSave(cwd, id, previous).catch(() => undefined);
      else await projectScriptCommandDelete(cwd, id).catch(() => undefined);
    } catch (cause) {
      setError(`${t("chat.projectScripts.saveError")} ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusySave(false);
    }
  };

  const importFromT3 = async () => {
    setBusyImport(true);
    setError("");
    try {
      const imported = await readT3ProjectScripts(cwd);
      if (imported.length === 0) {
        setError(t("chat.projectScripts.noImportable"));
        return;
      }
      setCandidates(imported);
      setSelected(new Set(imported.flatMap((candidate, index) => candidate.containsSecret || candidate.tooLarge ? [] : [index])));
      setEditor(null);
    } catch (cause) {
      setError(`${t("chat.projectScripts.importError")} ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusyImport(false);
    }
  };

  const confirmImport = async () => {
    if (!candidates) return;
    const chosen = candidates.filter((_, index) => selected.has(index));
    if (chosen.some((candidate) => candidate.command === null || candidate.tooLarge)) {
      setError(t("chat.projectScripts.commandTooLarge"));
      return;
    }
    if (chosen.some((candidate) => candidate.containsSecret)) {
      setError(t("chat.projectScripts.secretInline"));
      return;
    }
    if (scripts.length + chosen.length > 32) {
      setError(t("chat.projectScripts.limit"));
      return;
    }

    const staged = [...scripts];
    const additions: ChatProjectScript[] = [];
    const savedIds: string[] = [];
    setBusySave(true);
    setError("");
    try {
      for (const candidate of chosen) {
        // Os flags do T3 são apenas sugestões na revisão; cada gatilho precisa de opt-in no editor da ADE.
        const script = makeProjectScript(candidate.name, newProjectScriptId(candidate.name, staged), false, false, candidate.previewUrl ?? undefined);
        if (!script) continue;
        if (candidate.command === null) throw new Error(t("chat.projectScripts.commandTooLarge"));
        await projectScriptCommandSave(cwd, script.id, candidate.command);
        savedIds.push(script.id);
        additions.push(script);
        staged.push(script);
      }
      if (persist([...scripts, ...additions])) {
        setCandidates(null);
        setSelected(new Set());
      } else {
        await Promise.all(savedIds.map((id) => projectScriptCommandDelete(cwd, id).catch(() => undefined)));
      }
    } catch (cause) {
      await Promise.all(savedIds.map((id) => projectScriptCommandDelete(cwd, id).catch(() => undefined)));
      setError(`${t("chat.projectScripts.saveError")} ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusySave(false);
    }
  };

  const run = async (script: ChatProjectScript) => {
    setRunning(script.id);
    setError("");
    try {
      const command = await projectScriptCommandGet(cwd, script.id);
      if (command === null) {
        setError(t("chat.projectScripts.commandMissing"));
        return;
      }
      if (projectScriptCommandContainsSecret(command)) {
        setError(t("chat.projectScripts.secretInline"));
        return;
      }
      await runProjectScript(cwd, script.name, command);
      setOpen(false);
    } catch (cause) {
      setError(t("chat.projectScripts.runError", { error: String(cause) }));
    } finally {
      setRunning(null);
    }
  };

  const openPreview = (script: ChatProjectScript) => {
    if (!script.previewUrl || !owner) return;
    const url = normalizeProjectPreviewUrl(script.previewUrl);
    if (!url) {
      setError(t("chat.projectScripts.previewUrlInvalid"));
      return;
    }
    const state = useViewTabsStore.getState();
    const current = state.views.find((view): view is BrowserView => view.kind === "browser"
      && comparablePath(view.cwd) === comparablePath(cwd)
      && view.owner?.kind === owner.kind && view.owner.id === owner.id);
    const viewId = current
      ? current.id
      : state.openBrowser(cwd, url, { activate: false, owner });
    if (current) state.updateView(current.id, { url, title: new URL(url).host });
    const chat = useChatStore.getState();
    if (!chat.browserFloating || chat.browser?.viewId !== viewId) setRightPanel("browser");
    setOpen(false);
  };

  const edit = async (script: ChatProjectScript) => {
    setError("");
    try {
      const command = await projectScriptCommandGet(cwd, script.id);
      if (command === null) {
        setError(t("chat.projectScripts.commandMissing"));
        return;
      }
      if (projectScriptCommandContainsSecret(command)) {
        setEditor({ id: script.id, name: script.name, command: "", setup: script.setup, onSettle: script.onSettle, previewUrl: script.previewUrl ?? "" });
        setError(t("chat.projectScripts.secretEditor"));
        return;
      }
      setEditor({ id: script.id, name: script.name, command, setup: script.setup, onSettle: script.onSettle, previewUrl: script.previewUrl ?? "" });
    } catch (cause) {
      setError(`${t("chat.projectScripts.loadError")} ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  const remove = async (script: ChatProjectScript) => {
    const next = scripts.filter((item) => item.id !== script.id);
    if (!persist(next)) return;
    try {
      await projectScriptCommandDelete(cwd, script.id);
      useShortcutPreferences.getState().resetBinding(projectScriptShortcutId(cwd, script.id));
      setPendingDelete(null);
    } catch (cause) {
      persist(scripts);
      setError(`${t("chat.projectScripts.deleteError")} ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  return (
    <span ref={ref} className="relative">
      <button
        type="button"
        aria-label={t("chat.projectScripts.open")}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("chat.projectScripts.open")}
        onClick={() => { setOpen(!open); setError(""); }}
        className={`flex items-center justify-center w-7 h-7 rounded-lg hover:bg-gray-100 dark:hover:bg-white/[0.07] ${scripts.length ? "text-accent-600 dark:text-accent-400" : "text-gray-500 dark:text-white/45"}`}
      >
        <WrenchIcon className="w-3.5 h-3.5" />
      </button>
      {open && (
        <section role="dialog" aria-label={t("chat.projectScripts.title")} className="absolute right-0 bottom-full z-40 mb-2 w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-gray-200 bg-white p-2 shadow-xl dark:border-white/10 dark:bg-surface-raised">
          <header className="flex items-center justify-between gap-2 px-2 pb-1.5">
            <span className="text-[12px] font-medium text-gray-800 dark:text-white/85">{t("chat.projectScripts.title")}</span>
            <button type="button" aria-label={t("chat.projectScripts.close")} onClick={() => setOpen(false)} className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:text-white/50 dark:hover:bg-white/8"><XIcon className="h-3.5 w-3.5" /></button>
          </header>
          <div className="max-h-[min(24rem,60vh)] overflow-y-auto">
            {error && <p role="alert" className="mx-2 my-1 rounded-md bg-red-50 px-2 py-1.5 text-[10px] text-red-700 dark:bg-red-400/10 dark:text-red-300">{error}</p>}
            {editor ? (
              <form onSubmit={(event) => void saveEditor(event)} className="space-y-2 p-2">
                <label className="block text-[10px] text-gray-500 dark:text-white/55">
                  {t("chat.projectScripts.name")}
                  <input autoFocus required maxLength={100} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} className="mt-1 block w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-[11px] text-gray-800 outline-none focus:border-accent-500 dark:border-white/10 dark:bg-black/15 dark:text-white" />
                </label>
                <label className="block text-[10px] text-gray-500 dark:text-white/55">
                  {t("chat.projectScripts.command")}
                  <textarea required maxLength={8192} rows={4} value={editor.command} onChange={(event) => setEditor({ ...editor, command: event.target.value })} className="mt-1 block w-full resize-y rounded-md border border-gray-200 bg-white px-2 py-1.5 font-mono text-[10px] text-gray-800 outline-none focus:border-accent-500 dark:border-white/10 dark:bg-black/15 dark:text-white" />
                </label>
                <label className="block text-[10px] text-gray-500 dark:text-white/55">
                  {t("chat.projectScripts.previewUrl")}
                  <input type="url" maxLength={2048} value={editor.previewUrl} onChange={(event) => setEditor({ ...editor, previewUrl: event.target.value })} placeholder="http://localhost:5173" className="mt-1 block w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-[11px] text-gray-800 outline-none focus:border-accent-500 dark:border-white/10 dark:bg-black/15 dark:text-white" />
                </label>
                <p className="m-0 text-[10px] leading-4 text-gray-500 dark:text-white/45">{t("chat.projectScripts.previewUrlHelp")}</p>
                <fieldset className="space-y-1 rounded-md border border-gray-200 p-2 dark:border-white/10">
                  <legend className="px-1 text-[10px] font-medium text-gray-700 dark:text-white/70">{t("chat.projectScripts.automationTitle")}</legend>
                  <label className="flex items-start gap-2 text-[10px] leading-4 text-gray-600 dark:text-white/60">
                    <input type="checkbox" checked={editor.setup} onChange={(event) => setEditor({ ...editor, setup: event.target.checked })} />
                    <span>{t("chat.projectScripts.runOnWorktreeCreate")}</span>
                  </label>
                  <label className="flex items-start gap-2 text-[10px] leading-4 text-gray-600 dark:text-white/60">
                    <input type="checkbox" checked={editor.onSettle} onChange={(event) => setEditor({ ...editor, onSettle: event.target.checked })} />
                    <span>{t("chat.projectScripts.runOnSettle")}</span>
                  </label>
                </fieldset>
                <p className="m-0 text-[10px] leading-4 text-gray-500 dark:text-white/45">{t("chat.projectScripts.automationHelp")}</p>
                <div className="flex justify-end gap-2">
                  <button type="button" disabled={busySave} onClick={() => { setEditor(null); setError(""); }} className="rounded-md px-2 py-1.5 text-[10px] text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-white/60 dark:hover:bg-white/8">{t("chat.projectScripts.cancel")}</button>
                  <button type="submit" disabled={busySave} className="rounded-md bg-accent-600 px-2.5 py-1.5 text-[10px] font-medium text-white hover:bg-accent-700 disabled:opacity-50">{busySave ? t("chat.projectScripts.saving") : t("chat.projectScripts.save")}</button>
                </div>
              </form>
            ) : candidates ? (
              <div className="space-y-2 p-2">
                <p className="m-0 text-[10px] leading-4 text-gray-500 dark:text-white/50">{t("chat.projectScripts.importReview")}</p>
                <div className="space-y-1">
                  {candidates.map((candidate, index) => (
                    <label key={`${candidate.name}-${index}`} className="flex cursor-pointer gap-2 rounded-md border border-gray-200 p-2 hover:bg-gray-50 dark:border-white/10 dark:hover:bg-white/5">
                      <input type="checkbox" disabled={candidate.containsSecret || candidate.tooLarge} checked={selected.has(index)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(index); else next.delete(index); return next; })} />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1 text-[10px] font-medium text-gray-800 dark:text-white/75">
                          {candidate.name}
                          {candidate.setup && <span className="rounded bg-amber-100 px-1 text-[9px] text-amber-800 dark:bg-amber-300/10 dark:text-amber-200">{t("chat.projectScripts.setupTag")}</span>}
                          {candidate.onSettle && <span className="rounded bg-gray-100 px-1 text-[9px] text-gray-600 dark:bg-white/10 dark:text-white/50">{t("chat.projectScripts.settleTag")}</span>}
                        </span>
                        {candidate.previewUrl && <span className="mt-1 block truncate font-mono text-[9px] text-gray-500 dark:text-white/45">{candidate.previewUrl}</span>}
                        {candidate.invalidPreviewUrl && <span role="alert" className="mt-1 block text-[9px] leading-4 text-amber-700 dark:text-amber-300">{t("chat.projectScripts.previewUrlSkipped")}</span>}
                        {candidate.tooLarge ? <span role="alert" className="mt-1 block text-[9px] leading-4 text-amber-700 dark:text-amber-300">{t("chat.projectScripts.commandTooLarge")}</span> : candidate.containsSecret ? <span role="alert" className="mt-1 block text-[9px] leading-4 text-red-600 dark:text-red-300">{t("chat.projectScripts.secretCandidate")}</span> : <code className="mt-1 block max-h-14 overflow-auto whitespace-pre-wrap break-all text-[9px] leading-4 text-gray-500 dark:text-white/45">{candidate.command}</code>}
                      </span>
                    </label>
                  ))}
                </div>
                <p className="m-0 text-[10px] leading-4 text-gray-500 dark:text-white/45">{t("chat.projectScripts.importManualOnly")}</p>
                <div className="flex justify-end gap-2">
                  <button type="button" disabled={busySave} onClick={() => { setCandidates(null); setError(""); }} className="rounded-md px-2 py-1.5 text-[10px] text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-white/60 dark:hover:bg-white/8">{t("chat.projectScripts.cancel")}</button>
                  <button type="button" disabled={selected.size === 0 || busySave} onClick={() => void confirmImport()} className="rounded-md bg-accent-600 px-2.5 py-1.5 text-[10px] font-medium text-white hover:bg-accent-700 disabled:opacity-50">{busySave ? t("chat.projectScripts.importing") : t("chat.projectScripts.importSelected", { count: selected.size })}</button>
                </div>
              </div>
            ) : (
              <>
                {scripts.length === 0 ? <p className="m-0 px-2 py-3 text-[10px] text-gray-500 dark:text-white/45">{t("chat.projectScripts.empty")}</p> : (
                  <ul className="m-0 max-h-48 list-none space-y-1 overflow-y-auto p-0">
                    {scripts.map((script) => (
                      <li key={script.id} className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-gray-50 dark:hover:bg-white/5">
                        <span className="min-w-0 flex-1 truncate text-[11px] text-gray-800 dark:text-white/75">{script.name}</span>
                        {pendingDelete === script.id ? (
                          <>
                            <button type="button" disabled={busySave} onClick={() => void remove(script)} className="rounded px-1.5 py-1 text-[9px] text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-400/10">{t("chat.projectScripts.remove")}</button>
                            <button type="button" disabled={busySave} aria-label={t("chat.projectScripts.cancel")} onClick={() => setPendingDelete(null)} className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:text-white/45 dark:hover:bg-white/8"><XIcon className="h-3 w-3" /></button>
                          </>
                        ) : (
                          <>
                            <button type="button" disabled={running !== null || busySave} title={t("chat.projectScripts.run")} aria-label={t("chat.projectScripts.runNamed", { name: script.name })} onClick={() => void run(script)} className="rounded p-1 text-accent-700 hover:bg-accent-50 disabled:opacity-40 dark:text-accent-300 dark:hover:bg-white/8"><PlayIcon className="h-3 w-3" /></button>
                            {owner && script.previewUrl && <button type="button" title={t("chat.projectScripts.openPreview")} aria-label={t("chat.projectScripts.openPreviewNamed", { name: script.name })} onClick={() => openPreview(script)} className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:text-white/50 dark:hover:bg-white/8"><GlobeIcon className="h-3 w-3" /></button>}
                            <button type="button" disabled={busySave} title={t("chat.projectScripts.edit")} aria-label={t("chat.projectScripts.editNamed", { name: script.name })} onClick={() => void edit(script)} className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:text-white/50 dark:hover:bg-white/8"><SettingsIcon className="h-3 w-3" /></button>
                            <button type="button" disabled={busySave} title={t("chat.projectScripts.remove")} aria-label={t("chat.projectScripts.removeNamed", { name: script.name })} onClick={() => setPendingDelete(script.id)} className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:text-white/50 dark:hover:bg-white/8"><XIcon className="h-3 w-3" /></button>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="m-0 px-2 pb-1 text-[9px] leading-4 text-gray-500 dark:text-white/40">{t("chat.projectScripts.manualOnly")}</p>
                <div className="mt-1 border-t border-gray-200 pt-1.5 dark:border-white/8">
                  <button type="button" disabled={scripts.length >= 32 || busySave} onClick={() => { setEditor({ id: null, name: "", command: "", setup: false, onSettle: false, previewUrl: "" }); setError(""); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[10px] text-gray-700 hover:bg-gray-100 disabled:opacity-40 dark:text-white/70 dark:hover:bg-white/8"><PlusIcon className="h-3 w-3" />{t("chat.projectScripts.add")}</button>
                  <button type="button" disabled={busyImport || busySave || scripts.length >= 32} onClick={() => void importFromT3()} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[10px] text-gray-700 hover:bg-gray-100 disabled:opacity-40 dark:text-white/70 dark:hover:bg-white/8"><TerminalIcon className="h-3 w-3" />{busyImport ? t("chat.projectScripts.importing") : t("chat.projectScripts.import")}</button>
                </div>
              </>
            )}
          </div>
        </section>
      )}
    </span>
  );
}
