import { openUrl } from "@tauri-apps/plugin-opener";
import { PopupSelect } from "@/shared/ui/PopupSelect";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, EmptyState, Skeleton } from "neogestify-ui-components";

import { ExternalIcon, IssueIcon, PullRequestIcon, TagIcon } from "@/app/icons";
import { useShellGroups } from "@/app/shellContext";
import { useTabsStore } from "@/features/tabs/store";
import type { RepoGroup, WorkspaceNode } from "@/features/workspaces/workspaceTree";

import { ForgeItemsView, type ItemFilter } from "./ForgeItemsView";
import { ForgeIcon } from "./forgeMeta";
import { forgeSetRepoAccount } from "./ipc";
import { ItemDetailView } from "./ItemDetailView";
import { ReleasesView } from "./ReleasesView";
import { branchChips, browserUrl, repoStatus } from "./repoPanel";
import { SignInButton } from "./SignInButton";
import type { ForgeItem } from "./types";
import { useRepoTarget } from "./useRepoTarget";

type Section = "pulls" | "issues" | "releases";

/** Un repo con workspaces abiertos, y la carpeta desde la que se le habla. */
interface OpenRepo {
  key: string;
  name: string;
  /** El checkout principal si está abierto; si no, el primer worktree abierto. */
  main: WorkspaceNode;
  open: WorkspaceNode[];
}

function openRepos(groups: RepoGroup[]): OpenRepo[] {
  return groups
    .filter((g) => g.isRepo)
    .map((g) => {
      const open = g.workspaces.filter((w) => !w.closed);
      const main = open.find((w) => w.isPrimary) ?? open[0];
      return main ? { key: g.key, name: g.name, main, open } : null;
    })
    .filter((r): r is OpenRepo => r !== null);
}

/** Un repo de la columna: nombre, estado de la cuenta y sus ramas abiertas. */
function RepoRow({ repo, active, onClick }: { repo: OpenRepo; active: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const { target } = useRepoTarget(repo.main.cwd);
  const branches = [...new Set(repo.open.map((w) => w.branch).filter(Boolean))] as string[];
  const { shown, more } = branchChips(branches);
  const status = repoStatus(target);

  const dot = {
    loading: "bg-gray-300 dark:bg-white/20",
    noRemote: "bg-gray-300 dark:bg-white/20",
    connected: "bg-emerald-500",
    disconnected: "bg-amber-500",
  }[status];
  const statusText = {
    loading: "…",
    noRemote: t("forge.panel.noRemote"),
    connected: t("forge.panel.connectedAs", { login: target?.account?.login ?? "" }),
    disconnected: t("forge.panel.notConnected"),
  }[status];

  return (
    <Button variant="custom"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={`cc-t flex items-start gap-2.5 w-full px-2.5 py-2 rounded-lg text-left
        ${active
          ? "bg-accent-500/12 dark:bg-accent-400/13"
          : "hover:bg-gray-200/60 dark:hover:bg-white/5"}`}
    >
      <ForgeIcon kind={target?.kind ?? null} className="w-4 h-4 mt-0.5 shrink-0 text-gray-500 dark:text-white/45" />
      <span className="flex flex-col gap-1 min-w-0 flex-1">
        <span className={`truncate text-[13px] ${active ? "font-semibold text-gray-900 dark:text-white" : "font-medium text-gray-800 dark:text-gray-100"}`} title={repo.name}>
          {repo.name}
        </span>
        <span className="flex items-center gap-1.5 min-w-0 text-[11px] text-gray-500 dark:text-white/50">
          <span aria-hidden className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
          <span className="truncate">{statusText}</span>
        </span>
        {shown.length > 0 && (
          <span className="flex flex-wrap items-center gap-1 min-w-0">
            {shown.map((b) => (
              <span key={b} title={b}
                className="max-w-full truncate rounded px-1.5 py-px font-mono text-[10px] bg-gray-200/80 dark:bg-white/8 text-gray-600 dark:text-white/55">
                {b}
              </span>
            ))}
            {more > 0 && (
              <span className="rounded px-1.5 py-px font-mono text-[10px] text-gray-500 dark:text-white/45">+{more}</span>
            )}
          </span>
        )}
      </span>
    </Button>
  );
}

/**
 * Pull requests e issues de los repos abiertos, en su propia pantalla.
 *
 * A la izquierda los repos de los workspaces abiertos (varios worktrees del mismo repo son
 * un solo repo: los PRs son del repo, no de la carpeta). A la derecha, del elegido, sus
 * PRs y sus issues, cada uno con su filtro de estado; abrir uno lo muestra entero en la
 * misma pantalla.
 */
export function ForgePage() {
  const { t } = useTranslation();
  const groups = useShellGroups();
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const repos = useMemo(() => openRepos(groups), [groups]);
  const looseFolders = useMemo(
    () => groups.filter((g) => !g.isRepo && g.workspaces.some((w) => !w.closed)).length,
    [groups]
  );

  // Arranca en el repo de la tab activa: es casi siempre del que se quiere ver los PRs.
  const activeCwd = tabs.find((tab) => tab.id === activeTabId)?.cwd ?? null;
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (selected && repos.some((r) => r.key === selected)) return;
    const fromActive = repos.find((r) => r.open.some((w) => w.cwd === activeCwd));
    setSelected((fromActive ?? repos[0])?.key ?? null);
  }, [repos, selected, activeCwd]);

  const repo = repos.find((r) => r.key === selected) ?? null;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 h-[54px] shrink-0 pl-4 pr-14 border-b border-gray-200 dark:border-white/8">
        <PullRequestIcon className="w-[15px] h-[15px] shrink-0 text-violet-500 dark:text-violet-400" />
        <span className="text-[13.5px] font-bold text-gray-900 dark:text-white">{t("forge.panel.title")}</span>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* ══ los repos abiertos ═══════════════════════════════════════ */}
        <nav aria-label={t("forge.panel.openRepos")}
          className="flex flex-col w-64 shrink-0 min-h-0 border-r border-gray-200 dark:border-white/8
            bg-gray-100/50 dark:bg-black/20">
          <span className="shrink-0 px-4 pt-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.08em]
            text-gray-400 dark:text-white/35">
            {t("forge.panel.openRepos")}
          </span>
          <div className="flex-1 min-h-0 cc-scroll flex flex-col gap-0.5 px-1.5 pb-2">
            {repos.length === 0 ? (
              <p className="px-2.5 py-2 text-[11.5px] leading-relaxed text-gray-400 dark:text-white/35">
                {t("forge.page.none")}
              </p>
            ) : repos.map((r) => (
              <RepoRow key={r.key} repo={r} active={r.key === selected} onClick={() => setSelected(r.key)} />
            ))}
          </div>
          {looseFolders > 0 && (
            <p className="shrink-0 px-4 py-2 text-[10px] leading-relaxed border-t border-gray-200 dark:border-white/8
              text-gray-400 dark:text-white/30">
              {t("forge.page.loose", { count: looseFolders })}
            </p>
          )}
        </nav>

        {/* ══ PRs e issues del elegido ═════════════════════════════════ */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {repo ? (
            <RepoPane key={repo.key} repo={repo} />
          ) : (
            <EmptyState
              className="m-auto"
              icon={<PullRequestIcon className="w-8 h-8" />}
              title={t("forge.page.pick")}
              description={t("forge.page.pickDesc")}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Un repo: su cabecera (enlace, secciones y cuenta), y sus tres secciones. */
function RepoPane({ repo }: { repo: OpenRepo }) {
  const { t } = useTranslation();
  const cwd = repo.main.cwd;
  const { target, reload } = useRepoTarget(cwd);
  const [section, setSection] = useState<Section>("pulls");
  const [filters, setFilters] = useState<Record<"pulls" | "issues", ItemFilter>>({ pulls: "open", issues: "open" });
  const [opened, setOpened] = useState<Record<"pulls" | "issues", ForgeItem | null>>({ pulls: null, issues: null });
  // Cambia cuando algo se modificó adentro de un PR o issue (comentario, fusión): la lista
  // se vuelve a montar y se relee al volver.
  const [version, setVersion] = useState(0);

  if (target === undefined) {
    return (
      <div className="flex flex-col gap-3 p-5">
        {[50, 70, 40].map((w, i) => <Skeleton key={i} variant="text" height={14} width={`${w}%`} />)}
      </div>
    );
  }
  if (target === null) {
    return <EmptyState className="m-auto" icon={<PullRequestIcon className="w-8 h-8" />} title={t("forge.page.noRemote")} />;
  }

  const item = section === "releases" ? null : opened[section];
  const link = browserUrl(target.remoteUrl);
  const SECTIONS: Section[] = ["pulls", "issues", "releases"];

  return (
    <>
      {/* ── encabezado: repo, secciones, cuenta ─────────────────────── */}
      <div className="flex items-center gap-3 h-12 shrink-0 px-4 border-b border-gray-200 dark:border-white/8">
        <ForgeIcon kind={target.kind} className="w-4 h-4 shrink-0 text-gray-500 dark:text-white/45" />
        {link ? (
          <button type="button"
            onClick={() => { openUrl(link).catch(console.error); }}
            title={`${t("forge.panel.openInBrowser")} · ${link}`}
            aria-label={`${t("forge.panel.openInBrowser")}: ${target.path}`}
            className="cc-t group min-w-0 flex items-center gap-1.5 rounded-md px-1 -mx-1 py-0.5
              text-[13px] font-semibold text-gray-900 dark:text-white hover:text-accent-600 dark:hover:text-accent-300">
            <span className="truncate">{target.path}</span>
            <ExternalIcon className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60 transition-opacity" />
          </button>
        ) : (
          <span className="min-w-0 truncate text-[13px] font-semibold text-gray-900 dark:text-white" title={target.remoteUrl}>
            {target.path}
          </span>
        )}

        <div role="tablist" aria-label={t("forge.panel.title")}
          className="flex items-center gap-0.5 p-0.5 ml-2 rounded-lg bg-gray-200/60 dark:bg-white/6">
          {SECTIONS.map((s) => {
            const Icon = s === "pulls" ? PullRequestIcon : s === "issues" ? IssueIcon : TagIcon;
            const active = section === s;
            return (
              <Button variant="custom"
                key={s}
                role="tab"
                aria-selected={active}
                onClick={() => setSection(s)}
                className={`cc-t flex items-center gap-1.5 h-7 px-3 rounded-md text-[12px]
                  ${active
                    ? "bg-white dark:bg-white/12 text-gray-900 dark:text-white font-semibold shadow-sm"
                    : "text-gray-500 dark:text-white/50 hover:text-gray-800 dark:hover:text-white"}`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t(`forge.panel.${s}`)}
              </Button>
            );
          })}
        </div>

        <div className="flex-1" />
        {target.account && target.accounts.length > 1 ? (
          <PopupSelect
            value={target.account.id}
            onChange={async (e) => {
              await forgeSetRepoAccount(target.root, e.target.value).catch(console.error);
              setOpened({ pulls: null, issues: null });
              reload();
            }}
            title={t("forge.pickAccount")}
          >
            {target.accounts.map((a) => <option key={a.id} value={a.id}>@{a.login}</option>)}
          </PopupSelect>
        ) : target.account ? (
          <span className="flex items-center gap-1.5 text-[12px] text-gray-600 dark:text-white/60"
            title={t("forge.panel.connectedAs", { login: target.account.login })}>
            <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            @{target.account.login}
          </span>
        ) : (
          <SignInButton target={target} variant="outline" size="sm" label={t("forge.panel.signInShort")} />
        )}
      </div>

      {section === "releases" ? (
        <ReleasesView key={`releases-${target.account?.id ?? "none"}`} cwd={cwd} target={target} />
      ) : item ? (
        <ItemDetailView
          key={`${section}-${item.number}`}
          cwd={cwd}
          workspaces={repo.open}
          item={item}
          pr={section === "pulls"}
          onBack={() => setOpened((o) => ({ ...o, [section]: null }))}
          onChanged={() => setVersion((v) => v + 1)}
        />
      ) : (
        <ForgeItemsView
          key={`${section}-${version}-${target.account?.id ?? "none"}`}
          cwd={cwd}
          target={target}
          what={section}
          branch={repo.main.branch}
          filter={filters[section]}
          onFilter={(f) => setFilters((prev) => ({ ...prev, [section]: f }))}
          onOpen={(it) => setOpened((o) => ({ ...o, [section]: it }))}
        />
      )}
    </>
  );
}
