import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AnimateSpin, ArrowLeftIcon, ArrowRightIcon, Badge, Button, CheckIcon, ChevronDownIcon, ChevronRightIcon,
} from "neogestify-ui-components";

import { ExternalIcon, SendIcon } from "@/app/icons";
import { getRoster } from "@/features/runs/ipc";
import type { Roster } from "@/features/runs/types";
import { openNewAgentWith } from "@/features/tabs/tabActions";
import { PopupSelect } from "@/shared/ui/PopupSelect";

import { forgePullFiles, reviewGuideGet } from "./ipc";
import {
  GUIDE_AGENTS, askPrompt, askWorkdir, goTo, hostFileUrl, inRange, initStepper, isEditableTarget, loadVisited,
  nextStop, parsePatch, prevStop, saveVisited, stepperKey, visitedKey, type StepperState,
} from "./reviewGuide";
import { clearGuideJob, guideJobKey, startGuide, useReviewGuideStore } from "./reviewGuideStore";
import { forgeErrorOf, type ForgeItem, type GuideEntry, type GuideLookup, type GuideOutcome, type GuideStopFile, type PullFile } from "./types";

type Workspaces = { cwd: string; branch: string | null }[];

const RISK_VARIANT = { low: "success", medium: "warning", high: "danger" } as const;

/** Quem gera o guia. `agentId: null` = automático. Lembrado entre PRs (`localStorage`). */
interface AgentChoice { agentId: string | null; accountId: string | null; autoAccount: boolean }
const CHOICE_KEY = "cc-review-guide-agent";
const AUTO: AgentChoice = { agentId: null, accountId: null, autoAccount: true };

function loadChoice(): AgentChoice {
  try {
    const v = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? "null") as Partial<AgentChoice> | null;
    if (!v || typeof v !== "object") return AUTO;
    return {
      agentId: typeof v.agentId === "string" ? v.agentId : null,
      accountId: typeof v.accountId === "string" ? v.accountId : null,
      autoAccount: v.autoAccount !== false,
    };
  } catch {
    return AUTO;
  }
}

function saveChoice(choice: AgentChoice): void {
  try { localStorage.setItem(CHOICE_KEY, JSON.stringify(choice)); } catch { /* sem armazenamento */ }
}

/**
 * O guia de revisão do PR, dentro da tela do PR: gerar (com a escolha do agente), o aviso de
 * desatualizado e o passo a passo pelas paradas. Nada daqui escreve no GitHub.
 */
export function ReviewGuidePanel({ cwd, item, workspaces }: { cwd: string; item: ForgeItem; workspaces: Workspaces }) {
  const { t, i18n } = useTranslation();
  const job = useReviewGuideStore((s) => s.jobs[guideJobKey(cwd, item.number)]);
  const [lookup, setLookup] = useState<GuideLookup | null>(null);
  const [loadError, setLoadError] = useState("");
  const [failure, setFailure] = useState<GuideOutcome | null>(null);
  const [runError, setRunError] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [choice, setChoice] = useState<AgentChoice>(loadChoice);

  useEffect(() => {
    let alive = true;
    reviewGuideGet(cwd, item.number)
      .then((l) => alive && setLookup(l))
      .catch((e) => alive && setLoadError(forgeErrorOf(e).message));
    return () => { alive = false; };
  }, [cwd, item.number]);

  // O resultado de uma geração (talvez de antes de esta tela abrir): o guia vai para a tela e
  // o pedido sai da store.
  useEffect(() => {
    if (!job || job.status === "running") return;
    if (job.status === "error") setRunError(job.message);
    else if (job.outcome.entry) {
      setLookup({ entry: job.outcome.entry, headSha: job.outcome.entry.headSha, stale: false });
      setFailure(null);
    } else setFailure(job.outcome);
    clearGuideJob(cwd, item.number);
  }, [job, cwd, item.number]);

  const entry = lookup?.entry ?? null;
  const showOptions = choosing || !entry;
  useEffect(() => {
    if (!showOptions || roster) return;
    getRoster(false).then(setRoster).catch(() => setRoster({ agents: [] }));
  }, [showOptions, roster]);

  const agents = useMemo(
    () => (roster?.agents ?? []).filter((a) => (GUIDE_AGENTS as readonly string[]).includes(a.agentId) && a.installed && a.launchable),
    [roster],
  );
  const chosen = agents.find((a) => a.agentId === choice.agentId);

  const update = (patch: Partial<AgentChoice>) => {
    const next = { ...choice, ...patch };
    setChoice(next);
    saveChoice(next);
  };

  const generate = () => {
    setFailure(null);
    setRunError("");
    setChoosing(false);
    void startGuide(cwd, item.number, {
      agentId: chosen ? choice.agentId : null,
      accountId: chosen ? choice.accountId : null,
      autoAccount: chosen ? choice.autoAccount : true,
      model: null,
      lang: i18n.language,
      workdir: askWorkdir(workspaces, item, cwd),
    });
  };

  const running = job?.status === "running";

  return (
    <section className="rounded-xl border border-violet-200 dark:border-violet-500/25 overflow-hidden"
      aria-label={t("forge.guide.title")}>
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 bg-violet-50 dark:bg-violet-500/10
        border-b border-violet-200 dark:border-violet-500/25">
        <span className="text-[13px] font-semibold text-gray-900 dark:text-white">{t("forge.guide.title")}</span>
        {entry && (
          <Badge variant={RISK_VARIANT[entry.guide.risk]} size="sm">{t(`forge.guide.risk.${entry.guide.risk}`)}</Badge>
        )}
        {entry && lookup?.stale && <Badge variant="warning" size="sm">{t("forge.guide.stale")}</Badge>}
        {entry && (
          <span className="text-[11px] text-gray-500 dark:text-white/45">
            {t("forge.guide.meta", {
              agent: roster?.agents.find((a) => a.agentId === entry.agentId)?.label ?? entry.agentId,
              when: new Date(entry.createdAt).toLocaleString(),
            })}
            {entry.costUsd != null && ` · ${t("forge.guide.cost", { cost: entry.costUsd.toFixed(2) })}`}
          </span>
        )}
        <div className="flex-1" />
        {entry && !running && (
          <Button size="sm" variant="outline" onClick={() => setChoosing((c) => !c)}>
            {t("forge.guide.regenerate")}
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-3 px-4 py-3 text-[13px]">
        {loadError && <p className="text-[12px] text-red-500 dark:text-red-400 break-words">{t("forge.guide.loadError", { error: loadError })}</p>}
        {entry && lookup?.stale && (
          <p className="text-[12px] text-amber-700 dark:text-amber-300">
            {t("forge.guide.staleHint", { sha: entry.headSha.slice(0, 7) })}
          </p>
        )}

        {running ? (
          <div className="flex items-center gap-2 text-gray-600 dark:text-white/60">
            <AnimateSpin className="w-4 h-4" />
            {t("forge.guide.running")}
          </div>
        ) : showOptions && (
          <div className="flex flex-col gap-2">
            {!entry && <p className="text-gray-600 dark:text-white/60">{t("forge.guide.intro")}</p>}
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1 min-w-44">
                <label htmlFor="ReviewGuide-agent" className="text-[11px] font-medium text-gray-500 dark:text-white/45">{t("forge.guide.agent")}</label>
                <PopupSelect id="ReviewGuide-agent" value={chosen ? chosen.agentId : ""}
                  onChange={(e) => update({ agentId: e.target.value || null, accountId: null, autoAccount: true })}>
                  <option value="">{t("forge.guide.auto")}</option>
                  {agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.label}</option>)}
                </PopupSelect>
              </div>
              {chosen && (
                <div className="flex flex-col gap-1 min-w-44">
                  <label htmlFor="ReviewGuide-account" className="text-[11px] font-medium text-gray-500 dark:text-white/45">{t("forge.guide.account")}</label>
                  <PopupSelect id="ReviewGuide-account"
                    value={choice.autoAccount ? "__auto__" : choice.accountId ?? "__system__"}
                    onChange={(e) => {
                      const v = e.target.value;
                      update(v === "__auto__" ? { autoAccount: true, accountId: null }
                        : { autoAccount: false, accountId: v === "__system__" ? null : v });
                    }}>
                    <option value="__auto__">{t("forge.guide.autoAccount")}</option>
                    {chosen.accounts.filter((a) => a.loggedIn).map((a) => (
                      <option key={a.key} value={a.accountId ?? "__system__"}>
                        {a.accountId ? (a.label ?? a.name) : t("forge.guide.systemAccount")}
                      </option>
                    ))}
                  </PopupSelect>
                </div>
              )}
              <Button size="sm" variant="primary" onClick={generate}>{t("forge.guide.generate")}</Button>
            </div>
            {roster && agents.length === 0 && <p className="text-[12px] text-amber-700 dark:text-amber-300">{t("forge.guide.noAgents")}</p>}
          </div>
        )}

        {runError && <p className="text-[12px] text-red-500 dark:text-red-400 break-words">{runError}</p>}
        {failure && <GuideFailure outcome={failure} />}
        {entry && (
          <GuideTour key={`${entry.headSha}-${entry.createdAt}`} entry={entry} item={item} cwd={cwd} workspaces={workspaces} />
        )}
      </div>
    </section>
  );
}

function GuideFailure({ outcome }: { outcome: GuideOutcome }) {
  const { t } = useTranslation();
  const [showRaw, setShowRaw] = useState(true);
  return (
    <div className="flex flex-col gap-2 p-3 rounded-lg border border-red-200 dark:border-red-500/25 bg-red-50 dark:bg-red-500/10">
      <p className="text-[12px] text-red-600 dark:text-red-300">{t("forge.guide.failed")}</p>
      {outcome.errors.length > 0 && (
        <ul className="list-disc pl-5 text-[11.5px] text-red-600/90 dark:text-red-300/90 font-mono">
          {outcome.errors.slice(0, 12).map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      {outcome.raw && (
        <>
          <Button variant="custom" onClick={() => setShowRaw((s) => !s)}
            className="self-start flex items-center gap-1 text-[12px] text-gray-600 dark:text-white/60">
            {showRaw ? <ChevronDownIcon className="w-3 h-3" /> : <ChevronRightIcon className="w-3 h-3" />}
            {t("forge.guide.raw")}
          </Button>
          {showRaw && (
            <pre className="max-h-80 overflow-auto p-2 rounded-md text-[11px] whitespace-pre-wrap break-words
              bg-white dark:bg-black/30 text-gray-700 dark:text-white/70">{outcome.raw}</pre>
          )}
        </>
      )}
    </div>
  );
}

/** Os arquivos do PR, buscados uma vez por tela (só quando se abre o diff de um). */
type FilesState = { status: "idle" } | { status: "loading" } | { status: "ok"; files: PullFile[] } | { status: "error"; message: string };

function GuideTour({ entry, item, cwd, workspaces }: { entry: GuideEntry; item: ForgeItem; cwd: string; workspaces: Workspaces }) {
  const { t } = useTranslation();
  const guide = entry.guide;
  const vkey = visitedKey(entry.repo, entry.number, entry.headSha);
  const [state, setState] = useState<StepperState>(() => initStepper(guide, loadVisited(vkey)));
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [files, setFiles] = useState<FilesState>({ status: "idle" });

  useEffect(() => { saveVisited(vkey, state.visited); }, [vkey, state.visited]);
  useEffect(() => { setOpenFile(null); }, [state.current]);

  const stop = guide.stops[state.current];
  if (!stop) return null;
  const total = guide.stops.length;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isEditableTarget(e.target)) return;
    const dir = stepperKey(e);
    if (!dir) return;
    e.preventDefault();
    setState((s) => (dir === "next" ? nextStop(s, guide) : prevStop(s, guide)));
  };

  const toggleFile = (f: GuideStopFile, i: number) => {
    const id = `${i}:${f.path}`;
    setOpenFile((cur) => (cur === id ? null : id));
    if (files.status === "idle" || files.status === "error") {
      setFiles({ status: "loading" });
      forgePullFiles(cwd, item.number)
        .then((list) => setFiles({ status: "ok", files: list }))
        .catch((e) => setFiles({ status: "error", message: forgeErrorOf(e).message }));
    }
  };

  const openOnHost = (f: GuideStopFile) => {
    void hostFileUrl(item.webUrl, f.path, f.lines).then((url) => openUrl(url)).catch(console.error);
  };

  const ask = () => openNewAgentWith({
    cwd: askWorkdir(workspaces, item, cwd),
    title: t("forge.guide.askTitle", { n: item.number }),
    draft: askPrompt({ item, stop, index: state.current, total, summary: guide.summary, headSha: entry.headSha }),
  });

  return (
    <div className="flex flex-col gap-3 outline-none" tabIndex={0} onKeyDown={onKeyDown}
      aria-label={t("forge.guide.keys")}>
      <p className="text-gray-700 dark:text-white/75 leading-relaxed">{guide.summary}</p>

      {/* ── as paradas ───────────────────────────────────────────── */}
      <ol className="flex flex-wrap gap-1.5">
        {guide.stops.map((s, i) => {
          const seen = state.visited.includes(s.id);
          const current = i === state.current;
          return (
            <li key={s.id}>
              <Button variant="custom" onClick={() => setState((st) => goTo(st, guide, i))}
                aria-current={current ? "step" : undefined}
                title={s.title}
                className={`cc-t flex items-center gap-1 h-6 max-w-56 px-2 rounded-md text-[11.5px] border ${current
                  ? "border-violet-400 dark:border-violet-400/60 bg-violet-100 dark:bg-violet-500/20 text-violet-800 dark:text-violet-200"
                  : "border-gray-200 dark:border-white/10 text-gray-600 dark:text-white/55 hover:bg-gray-100 dark:hover:bg-white/6"}`}>
                {seen && !current ? <CheckIcon className="w-3 h-3 shrink-0" /> : <span className="shrink-0">{i + 1}.</span>}
                <span className="truncate">{s.title}</span>
              </Button>
            </li>
          );
        })}
      </ol>

      {/* ── a parada atual ───────────────────────────────────────── */}
      <div className="flex flex-col gap-3 p-3 rounded-lg border border-gray-200 dark:border-white/8">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] uppercase tracking-wide text-gray-400 dark:text-white/35">
            {t("forge.guide.stopOf", { n: state.current + 1, total })}
          </span>
          <span className="text-[11px] text-gray-400 dark:text-white/35">
            · {t("forge.guide.visited", { n: state.visited.length, total })}
          </span>
        </div>
        <h3 className="text-[15px] font-semibold text-gray-900 dark:text-white">{stop.title}</h3>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-gray-500 dark:text-white/45">{t("forge.guide.files")}</span>
          {stop.files.map((f, i) => {
            const id = `${i}:${f.path}`;
            const open = openFile === id;
            return (
              <div key={id} className="flex flex-col">
                <div className="flex items-center gap-1">
                  <Button variant="custom" onClick={() => toggleFile(f, i)} aria-expanded={open}
                    className="cc-t flex items-center gap-1 min-w-0 px-1.5 h-6 rounded-md font-mono text-[12px]
                      text-accent-700 dark:text-accent-300 hover:bg-gray-100 dark:hover:bg-white/6">
                    {open ? <ChevronDownIcon className="w-3 h-3 shrink-0" /> : <ChevronRightIcon className="w-3 h-3 shrink-0" />}
                    <span className="truncate">{f.path}</span>
                    {f.lines && <span className="shrink-0 text-gray-400 dark:text-white/35">:{f.lines.start}{f.lines.end !== f.lines.start ? `-${f.lines.end}` : ""}</span>}
                  </Button>
                  <Button variant="custom" onClick={() => openOnHost(f)} title={t("forge.guide.openOnHost")}
                    aria-label={t("forge.guide.openOnHost")}
                    className="cc-t h-6 w-6 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-700
                      dark:text-white/35 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/6">
                    <ExternalIcon className="w-3 h-3" />
                  </Button>
                </div>
                {open && <FileDiff state={files} file={f} />}
              </div>
            );
          })}
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-gray-500 dark:text-white/45">{t("forge.guide.why")}</span>
          <p className="text-gray-700 dark:text-white/75 leading-relaxed">{stop.why}</p>
        </div>

        {stop.lookClosely.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-gray-500 dark:text-white/45">{t("forge.guide.lookClosely")}</span>
            <ul className="list-disc pl-5 flex flex-col gap-0.5 text-gray-700 dark:text-white/75">
              {stop.lookClosely.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          </div>
        )}

        {stop.excerpt && (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-gray-500 dark:text-white/45">{t("forge.guide.excerpt")}</span>
            <pre className="max-h-60 overflow-auto p-2 rounded-md text-[11.5px] font-mono whitespace-pre
              bg-gray-50 dark:bg-white/4 text-gray-700 dark:text-white/70">{stop.excerpt}</pre>
          </div>
        )}

        {stop.questions && stop.questions.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-gray-500 dark:text-white/45">{t("forge.guide.questions")}</span>
            <ul className="list-disc pl-5 flex flex-col gap-0.5 text-gray-700 dark:text-white/75">
              {stop.questions.map((q, i) => <li key={i}>{q}</li>)}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant="outline" disabled={state.current === 0}
            onClick={() => setState((s) => prevStop(s, guide))} className="flex items-center gap-1">
            <ArrowLeftIcon className="w-3 h-3" />{t("forge.guide.prev")}
          </Button>
          <Button size="sm" variant="outline" disabled={state.current >= total - 1}
            onClick={() => setState((s) => nextStop(s, guide))} className="flex items-center gap-1">
            {t("forge.guide.next")}<ArrowRightIcon className="w-3 h-3" />
          </Button>
          <div className="flex-1" />
          <span className="text-[11px] text-gray-400 dark:text-white/35">{t("forge.guide.keys")}</span>
          <Button size="sm" variant="primary" onClick={ask} className="flex items-center gap-1.5">
            <SendIcon className="w-3 h-3" />{t("forge.guide.ask")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function FileDiff({ state, file }: { state: FilesState; file: GuideStopFile }) {
  const { t } = useTranslation();
  const patch = state.status === "ok" ? state.files.find((f) => f.path === file.path)?.patch ?? null : null;
  const lines = useMemo(() => (patch ? parsePatch(patch) : []), [patch]);
  if (state.status === "loading" || state.status === "idle") {
    return <p className="ml-5 my-1 text-[12px] text-gray-400 dark:text-white/40">{t("forge.guide.loadingDiff")}</p>;
  }
  if (state.status === "error") {
    return <p className="ml-5 my-1 text-[12px] text-red-500 dark:text-red-400">{t("forge.guide.diffError", { error: state.message })}</p>;
  }
  if (!patch) return <p className="ml-5 my-1 text-[12px] text-gray-400 dark:text-white/40">{t("forge.guide.noPatch")}</p>;
  return (
    <div className="ml-5 my-1 max-h-80 overflow-auto rounded-md border border-gray-200 dark:border-white/8 font-mono text-[11.5px]">
      {lines.map((l, i) => {
        const tone = l.kind === "add" ? "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
          : l.kind === "del" ? "bg-red-50 dark:bg-red-500/10 text-red-800 dark:text-red-200"
            : l.kind === "hunk" ? "bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300"
              : "text-gray-700 dark:text-white/65";
        const focus = inRange(l, file.lines) ? "ring-1 ring-inset ring-amber-400/70" : "";
        return (
          <div key={i} className={`flex whitespace-pre ${tone} ${focus}`}>
            <span className="select-none w-10 shrink-0 pr-2 text-right text-gray-400 dark:text-white/30">{l.newLine ?? ""}</span>
            <span className="pr-3">{l.text || " "}</span>
          </div>
        );
      })}
    </div>
  );
}
