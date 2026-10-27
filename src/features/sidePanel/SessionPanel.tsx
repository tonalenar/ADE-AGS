import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "neogestify-ui-components";

import { useUiStore } from "@/app/uiStore";
import { BranchIcon, FolderOpenIcon, PullRequestIcon, RunningIcon } from "@/app/icons";
import type { RepoInfo } from "@/features/explorer/types";
import { forgePullFiles, forgePulls } from "@/features/forge/ipc";
import type { ForgeItem } from "@/features/forge/types";
import { useRunsStore } from "@/features/runs/store";
import type { Tab } from "@/features/tabs/types";
import { homeDir } from "@/shared/ipc/window";

import { ConnectorsSection, ContextSection } from "./AgentSections";
import { CARD, Row, Section } from "./Section";
import { backgroundTasks, branchPulls, folderLabel, formatElapsed } from "./panelModel";

const PR_STATE: Record<string, string> = { open: "text-emerald-500", merged: "text-violet-500", closed: "text-gray-400" };

/** Os PRs da branch com o +/− de cada um. Pede de novo quando a branch muda e a cada minuto. */
function usePulls(cwd: string | null, branch: string | null) {
  const [pulls, setPulls] = useState<ForgeItem[] | null>(null);
  const [stats, setStats] = useState<Record<number, { add: number; del: number }>>({});
  useEffect(() => {
    setPulls(null);
    setStats({});
    if (!cwd || !branch) return;
    let alive = true;
    const load = () => forgePulls(cwd, "all")
      .then(async (items) => {
        const mine = branchPulls(items, branch);
        if (!alive) return;
        setPulls(mine);
        for (const pr of mine) {
          const files = await forgePullFiles(cwd, pr.number).catch(() => null);
          if (!alive || !files) continue;
          const add = files.reduce((n, f) => n + f.additions, 0);
          const del = files.reduce((n, f) => n + f.deletions, 0);
          setStats((s) => ({ ...s, [pr.number]: { add, del } }));
        }
      })
      // Sem conta do forge ou sem remoto: a seção mostra só o git local.
      .catch(() => alive && setPulls([]));
    load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [cwd, branch]);
  return { pulls, stats };
}

/** Relógio de segundos só enquanto há tarefa rodando. */
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * O painel da sessão, à direita: o que importa sobre o agente ativo, no formato do painel do Claude
 * Code — onde ele roda (Ambiente), quanto do contexto já gastou, que MCPs tem, o que mudou (git e PRs)
 * e o que roda em segundo plano. Substitui a coluna fixa de arquivos, que foi para a gaveta.
 */
export function SessionPanel({ tab, repo }: { tab: Tab | null; repo: RepoInfo | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openDrawer = useUiStore((s) => s.openDrawer);
  const cancelTask = useRunsStore((s) => s.cancelTask);
  const tasks = useRunsStore((s) => s.tasks);
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => { homeDir().then(setHome).catch(() => setHome(null)); }, []);

  const cwd = tab?.cwd ?? null;
  const branch = repo?.branch ?? null;
  const { pulls, stats } = usePulls(repo?.root ? cwd : null, branch);
  const bg = backgroundTasks(tasks, repo?.root ?? cwd);
  const now = useNow(bg.live.length > 0);
  const folder = cwd ? folderLabel(cwd, home) : null;
  const repoName = repo?.root ? folderLabel(repo.root, null).name : folder?.name;

  return (
    // Flutuante, sem coluna: cartões soltos no canto de cima, por cima do conteúdo, que segue com a
    // largura toda (e a barra do canvas no canto de baixo). Só os cartões pegam clique; o vão entre
    // eles e o resto da área continuam do terminal ou do canvas embaixo. O alto para antes da barra.
    <aside data-session-panel className="cc-fade cc-scroll absolute top-2 right-2 z-[33] flex flex-col gap-2 w-72
      max-h-[calc(100%-5.5rem)] overflow-y-auto pointer-events-none [&>*]:pointer-events-auto">
      {!tab ? (
        <p className={`${CARD} px-3 py-4 text-center text-[12px] text-gray-400 dark:text-white/35`}>{t("sidePanel.empty")}</p>
      ) : (
        <>
          <Section id="env" title={t("sidePanel.env.title")}>
            <Row icon={<FolderOpenIcon className="w-3.5 h-3.5" />} title={cwd ?? undefined}
              onClick={cwd ? () => { revealItemInDir(cwd).catch(console.error); } : undefined}>
              <span className="font-medium">{repoName}</span>
            </Row>
            {folder && (
              <Row icon={<FolderOpenIcon className="w-3.5 h-3.5 opacity-60" />} title={cwd ?? undefined}
                onClick={() => openDrawer("files")}>
                {folder.name} <span className="text-gray-400 dark:text-white/35">· {folder.parent}</span>
              </Row>
            )}
            {branch && (
              <Row icon={<BranchIcon className="w-3.5 h-3.5" />} onClick={() => openDrawer("scm")}
                trailing={repo?.isWorktree && (
                  <span className="shrink-0 px-1.5 rounded text-[10px] font-semibold bg-sky-500/12 text-sky-600 dark:text-sky-400">
                    {t("sidePanel.env.worktree")}
                  </span>
                )}>
                {branch}
              </Row>
            )}
          </Section>

          <ContextSection tab={tab} />
          <ConnectorsSection tab={tab} />

          <Section id="changes" title={t("sidePanel.changes.title")}
            aside={repo && repo.changedCount > 0
              ? <span className="text-[11px] text-amber-600 dark:text-amber-400 tabular-nums">{repo.changedCount}</span>
              : undefined}>
            {repo?.root ? (
              <Row icon={<BranchIcon className="w-3.5 h-3.5" />} onClick={() => openDrawer("scm")}>
                {repo.changedCount > 0 ? t("sidePanel.changes.local", { count: repo.changedCount }) : t("sidePanel.changes.clean")}
              </Row>
            ) : (
              <Row>{t("sidePanel.changes.noRepo")}</Row>
            )}
            {pulls?.map((pr) => (
              <Row key={pr.number} title={pr.title}
                icon={<PullRequestIcon className={`w-3.5 h-3.5 ${PR_STATE[pr.state] ?? ""}`} />}
                onClick={() => { openUrl(pr.webUrl).catch(console.error); }}>
                <span className="block truncate">{pr.title}</span>
                <span className="block text-[11px] text-gray-400 dark:text-white/35 tabular-nums">
                  #{pr.number}
                  {stats[pr.number] && (
                    <>
                      {" "}<span className="text-emerald-600 dark:text-emerald-400">+{stats[pr.number].add}</span>
                      {" "}<span className="text-rose-600 dark:text-rose-400">−{stats[pr.number].del}</span>
                    </>
                  )}
                  {" · "}{t(`sidePanel.changes.pr.${pr.draft && pr.state === "open" ? "draft" : pr.state}`)}
                </span>
              </Row>
            ))}
          </Section>

          <Section id="tasks" title={t("sidePanel.tasks.title")}
            aside={bg.live.length > 0
              ? <span className="text-[11px] text-emerald-600 dark:text-emerald-400 tabular-nums">{bg.live.length}</span>
              : undefined}>
            {bg.live.map((task) => (
              <Row key={task.id} title={task.prompt}
                icon={<RunningIcon className="w-3.5 h-3.5 text-emerald-500" />}
                onClick={() => navigate("/fleet")}
                trailing={(
                  <>
                    <span className="shrink-0 text-[11px] text-gray-400 dark:text-white/35 tabular-nums">
                      {task.startedAt ? formatElapsed(now - task.startedAt) : t("sidePanel.tasks.waiting")}
                    </span>
                    <Button variant="custom" title={t("sidePanel.tasks.stop")} aria-label={t("sidePanel.tasks.stop")}
                      onClick={(e) => { e.stopPropagation(); cancelTask(task.id).catch(console.error); }}
                      className="cc-t group flex items-center justify-center shrink-0 w-5 h-5 rounded p-0">
                      <span className="block w-2.5 h-2.5 rounded-[2px] bg-gray-400/80 dark:bg-white/40 group-hover:bg-rose-500" />
                    </Button>
                  </>
                )}>
                {task.title}
              </Row>
            ))}
            <Row onClick={bg.finished > 0 || bg.live.length === 0 ? () => navigate("/fleet") : undefined}>
              <span className="text-gray-500 dark:text-white/45">
                {bg.live.length === 0 && bg.finished === 0
                  ? t("sidePanel.tasks.none")
                  : t("sidePanel.tasks.finished", { count: bg.finished })}
              </span>
            </Row>
          </Section>
        </>
      )}
    </aside>
  );
}
