import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Alert, Button, FolderIcon } from "neogestify-ui-components";

import { ModelSelector } from "@/features/runs/ModelSelector";
import { getRoster } from "@/features/runs/ipc";
import type { Roster } from "@/features/runs/types";
import { FastSwitch } from "@/features/squads/FastSwitch";
import { modelsForAccount } from "@/features/squads/modelSelection";
import { useTabsStore } from "@/features/tabs/store";
import { AppDialog } from "@/shared/ui/AppDialog";
import { PopupSelect } from "@/shared/ui/PopupSelect";

import { compareCheck } from "./ipc";
import { MAX_PICKS, defaultTitle, draftProblem } from "./model";
import { startComparison } from "./start";
import { closeCompareDialog } from "./store";
import type { PickDraft, RepoCheck } from "./types";

const field = "w-full px-2 rounded-md text-[12.5px] outline-none bg-white dark:bg-white/8 border border-gray-300 dark:border-white/15 focus:border-accent-400 text-gray-800 dark:text-gray-100";
const labelCls = "text-[12px] font-medium text-gray-600 dark:text-gray-300";

/** As duas primeiras escolhas: Claude Code e Codex, se estão instalados; senão os primeiros que houver. */
function initialPicks(available: string[]): PickDraft[] {
  const preferred = ["claude-code", "codex", "opencode", "gemini-cli"].filter((id) => available.includes(id));
  const order = [...preferred, ...available.filter((id) => !preferred.includes(id))];
  return order.slice(0, 2).map((agentId) => ({ agentId, model: null, effort: null, fast: false }));
}

/**
 * "Comparar modelos": a pasta, o pedido e de 2 a 6 agentes/modelos. Ao iniciar, cada um ganha um
 * worktree e uma branch e recebe o mesmo pedido num terminal do canvas da comparação.
 */
export function CompareDialog({ initialCwd }: { initialCwd: string }) {
  const { t } = useTranslation();
  const detected = useTabsStore((s) => s.detectedAgents);
  const agents = useMemo(() => detected.filter((a) => a.available && a.id !== "bash"), [detected]);
  const available = useMemo(() => agents.map((a) => a.id), [agents]);
  const [cwd, setCwd] = useState(initialCwd);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [isolate, setIsolate] = useState(true);
  const [picks, setPicks] = useState<PickDraft[]>(() => initialPicks(available));
  const [roster, setRoster] = useState<Roster | null>(null);
  const [check, setCheck] = useState<RepoCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { getRoster().then(setRoster).catch(() => setRoster(null)); }, []);
  useEffect(() => {
    if (!cwd.trim()) { setCheck(null); return; }
    let alive = true;
    const timer = window.setTimeout(() => {
      compareCheck(cwd.trim()).then((c) => alive && setCheck(c)).catch((e) => alive && setCheck({ repo: null, branch: null, head: null, dirty: 0, error: String(e) }));
    }, 250);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [cwd]);

  const isRepo = Boolean(check?.repo);
  const problem = !cwd.trim() ? "compare.error.folder" : draftProblem({ prompt, picks, isolate, isRepo, available });
  const ready = !problem && !busy && check !== null;

  const setPick = (i: number, patch: Partial<PickDraft>) => setPicks((cur) => cur.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const addPick = () => setPicks((cur) => (cur.length >= MAX_PICKS ? cur : [...cur, { agentId: available[0] ?? "", model: null, effort: null, fast: false }]));
  const removePick = (i: number) => setPicks((cur) => cur.filter((_, j) => j !== i));

  const pickFolder = async () => {
    const dir = await open({ directory: true, multiple: false, defaultPath: cwd || undefined });
    if (typeof dir === "string") setCwd(dir);
  };

  const start = async () => {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      await startComparison({ cwd: cwd.trim(), title: title.trim() || defaultTitle(prompt), prompt, isolate, isRepo, picks });
      closeCompareDialog();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <AppDialog title={t("compare.title")} size="xl" closeOnEsc onClose={() => !busy && closeCompareDialog()}
      footer={(
        <>
          <span className="mr-auto text-[11px] text-gray-500 dark:text-gray-400">{t("compare.costNote", { count: picks.length })}</span>
          <Button variant="outline" disabled={busy} onClick={closeCompareDialog}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void start()}>
            {busy ? t("compare.starting") : t("compare.start", { count: picks.length })}
          </Button>
        </>
      )}>
      <div className="flex flex-col gap-4">
        <p className="text-[12px] text-gray-500 dark:text-gray-400">{t("compare.intro")}</p>

        <label className="flex flex-col gap-1">
          <span className={labelCls}>{t("compare.folder")}</span>
          <div className="flex gap-2">
            <input className={`${field} h-8`} value={cwd} disabled={busy} onChange={(e) => setCwd(e.target.value)} placeholder={t("compare.folderPlaceholder")} />
            <Button variant="outline" disabled={busy} onClick={() => void pickFolder()} aria-label={t("compare.pickFolder")} title={t("compare.pickFolder")}>
              <FolderIcon className="w-4 h-4" />
            </Button>
          </div>
          {check?.repo && (
            <span className="text-[11px] text-gray-500 dark:text-gray-400">
              {t("compare.repoInfo", { branch: check.branch ?? "HEAD", head: check.head ?? "" })}
              {check.dirty > 0 && isolate ? ` ${t("compare.repoDirty", { count: check.dirty })}` : ""}
            </span>
          )}
          {check && !check.repo && cwd.trim() && <span className="text-[11px] text-amber-700 dark:text-amber-300">{t("compare.notRepo")}</span>}
        </label>

        <label className="flex flex-col gap-1">
          <span className={labelCls}>{t("compare.prompt")}</span>
          <textarea className={`${field} py-1.5 min-h-[110px] font-mono`} value={prompt} disabled={busy}
            onChange={(e) => setPrompt(e.target.value)} placeholder={t("compare.promptPlaceholder")} />
        </label>

        <label className="flex flex-col gap-1">
          <span className={labelCls}>{t("compare.name")}</span>
          <input className={`${field} h-8`} value={title} maxLength={80} disabled={busy}
            onChange={(e) => setTitle(e.target.value)} placeholder={defaultTitle(prompt) || t("compare.namePlaceholder")} />
        </label>

        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-[12.5px] text-gray-700 dark:text-gray-200">
            <input type="checkbox" checked={isolate} disabled={busy} onChange={(e) => setIsolate(e.target.checked)} />
            {t("compare.isolate")}
          </label>
          {!isolate && <Alert variant="warning">{t("compare.sharedWarning")}</Alert>}
        </div>

        <fieldset className="flex flex-col gap-2" disabled={busy}>
          <legend className={`${labelCls} mb-1`}>{t("compare.models", { count: picks.length, max: MAX_PICKS })}</legend>
          {picks.map((pick, i) => {
            const agent = roster?.agents.find((a) => a.agentId === pick.agentId);
            const catalog = modelsForAccount(agent, null, true);
            return (
              <div key={i} className="grid grid-cols-1 md:grid-cols-[minmax(0,180px)_minmax(0,1fr)_auto] gap-2.5 items-start rounded-xl border border-gray-200 dark:border-white/10 p-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[10.5px] font-semibold text-gray-600 dark:text-gray-300">{t("compare.agent")}</span>
                  <PopupSelect aria-label={t("compare.agent")} value={pick.agentId}
                    onChange={(e) => setPick(i, { agentId: e.target.value, model: null, effort: null, fast: false })}>
                    {agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </PopupSelect>
                </label>
                <div className="flex flex-col gap-2">
                  <ModelSelector roster={roster} agentId={pick.agentId} accountId={null} autoAccount allowComplexity={false}
                    model={pick.model} complexity={null} reasoningEffort={pick.effort} onRoster={setRoster}
                    onChange={(patch) => setPick(i, { model: patch.model, effort: patch.reasoningEffort ?? null })} />
                  {pick.agentId === "codex" && (
                    <FastSwitch checked={pick.fast} model={pick.model} catalog={catalog} onChange={(fast) => setPick(i, { fast })} />
                  )}
                </div>
                <Button variant="custom" disabled={picks.length <= 2} onClick={() => removePick(i)} aria-label={t("compare.removeModel")} title={t("compare.removeModel")}
                  className="cc-t h-7 px-2 rounded-md text-[12px] text-gray-500 hover:text-red-600 disabled:opacity-35">
                  {t("compare.removeModel")}
                </Button>
              </div>
            );
          })}
          <Button variant="custom" disabled={picks.length >= MAX_PICKS} onClick={addPick}
            className="cc-t self-start h-7 px-2.5 rounded-md text-[12px] font-medium text-accent-600 dark:text-accent-400 hover:bg-accent-500/10 disabled:opacity-40">
            {t("compare.addModel")}
          </Button>
        </fieldset>

        {problem && problem !== "compare.error.prompt" && problem !== "compare.error.folder" && (
          <span role="status" className="text-[11.5px] text-amber-700 dark:text-amber-300">{t(problem)}</span>
        )}
        {error && <Alert variant="danger">{error}</Alert>}
      </div>
    </AppDialog>
  );
}
