import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  BoxIcon, ClockIcon, CloudIcon, GearIcon, HomeIcon, LocationIcon, MoonIcon, NetworkIcon,
  SearchIcon, StackIcon, SunIcon, UserIcon, UsersIcon, WarningIcon, useTheme,
} from "neogestify-ui-components";

import { useUiStore } from "@/app/uiStore";
import { SHORTCUTS } from "@/app/shortcuts";
import { PanelIcon, PullRequestIcon } from "@/app/icons";
import { agentIcon } from "@/features/agents/agentIcons";
import { useRunsStore } from "@/features/runs/store";
import { useTabsStore } from "@/features/tabs/store";
import { useWorkspacesStore } from "@/features/workspaces/store";
import { useFocusInside } from "@/shared/ui/useFocusInside";

import { rank, type Searchable } from "./match";

type Group = "agents" | "navigate" | "workspaces" | "actions";

interface Command extends Searchable {
  id: string;
  group: Group;
  icon: React.ReactNode;
  subtitle?: string;
  shortcut?: string;
  run: () => void;
}

const GROUP_ORDER: Group[] = ["agents", "navigate", "workspaces", "actions"];

/** O atalho que leva a uma rota, para mostrar ao lado do comando. */
function shortcutOf(path: string): string | undefined {
  return SHORTCUTS.find((s) => s.action.kind === "goto" && s.action.path === path)?.display;
}

/**
 * A paleta de comandos (Ctrl+K).
 *
 * Um lugar só para ir a qualquer seção, pular para um agente aberto, abrir um workspace
 * salvo ou fazer as ações da janela — sem ter que lembrar onde cada coisa mora no riel.
 *
 * Os comandos se montam a cada abertura a partir dos stores: o que está aberto, salvo ou
 * pendente agora. A busca (ver `match.ts`) ordena por relevância; sem busca, valem a
 * ordem dos grupos e a de cada lista.
 */
export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  if (!open) return null;
  return <PaletteDialog />;
}

function PaletteDialog() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const ui = useUiStore();
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activateTab = useTabsStore((s) => s.activateTab);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const loadWorkspaces = useWorkspacesStore((s) => s.loadWorkspaces);
  const focusIfOpen = useWorkspacesStore((s) => s.focusIfOpen);
  const openWorkspace = useWorkspacesStore((s) => s.openWorkspace);
  const approvals = useRunsStore((s) => s.approvals.length);

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useFocusInside(frameRef);

  useEffect(() => { loadWorkspaces().catch(console.error); }, [loadWorkspaces]);

  const close = () => ui.setPaletteOpen(false);
  const go = (path: string) => () => navigate(path);
  const icon = "w-4 h-4";

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];

    for (const tab of tabs) {
      const Icon = agentIcon(tab.agentId, tab.agentId);
      list.push({
        id: `tab:${tab.id}`,
        group: "agents",
        title: tab.title,
        subtitle: tab.cwd,
        keywords: [tab.agentLabel, tab.cwd],
        icon: <Icon className={icon} />,
        run: () => { activateTab(tab.id); navigate("/workspace"); },
      });
    }

    if (approvals > 0) {
      list.push({
        id: "approvals",
        group: "navigate",
        title: t("palette.cmd.approvals", { count: approvals }),
        keywords: ["approval", "permission", "permissão", "aprovação"],
        icon: <WarningIcon className={`${icon} text-amber-500`} />,
        run: go("/fleet"),
      });
    }

    const sections: [string, string, React.ReactNode, string[]][] = [
      ["/", t("sidebar.home"), <HomeIcon className={icon} />, ["home", "inicio", "novo agente", "new agent"]],
      ["/sessions", t("sidebar.sessions"), <ClockIcon className={icon} />, ["sessions", "history", "histórico"]],
      ["/fleet", t("sidebar.fleet"), <NetworkIcon className={icon} />, ["fleet", "frota", "flota"]],
      ["/missions", t("sidebar.missions"), <LocationIcon className={icon} />, ["missions", "misiones"]],
      ["/squads", t("sidebar.squads"), <UsersIcon className={icon} />, ["squads", "equipes", "teams"]],
      ["/forge", t("sidebar.forge"), <PullRequestIcon className={icon} />, ["forge", "pull request", "issues", "github"]],
      ["/skills", t("sidebar.skills"), <BoxIcon className={icon} />, ["skills", "habilidades"]],
      ["/marketplace", t("sidebar.marketplace"), <CloudIcon className={icon} />, ["marketplace", "loja"]],
      ["/workspaces", t("rail.workspaces"), <StackIcon className={icon} />, ["workspaces"]],
    ];
    for (const [path, title, el, keywords] of sections) {
      list.push({ id: `nav:${path}`, group: "navigate", title, keywords, icon: el, shortcut: shortcutOf(path), run: go(path) });
    }

    for (const ws of [...workspaces].sort((a, b) => b.lastActive - a.lastActive)) {
      list.push({
        id: `ws:${ws.id}`,
        group: "workspaces",
        title: ws.name,
        subtitle: t("palette.workspaceMeta", { tabs: ws.tabCount }),
        keywords: ["workspace"],
        icon: <StackIcon className={icon} />,
        // Já aberto em outra janela: só a traz para frente. Senão abre ao lado, sem fechar
        // nada — fechar o que está aberto é decisão do diálogo da tela de Workspaces.
        run: () => {
          focusIfOpen(ws.id)
            .then((focused) => (focused ? undefined : openWorkspace(ws.id, false)))
            .catch(console.error);
        },
      });
    }

    list.push(
      {
        id: "act:theme",
        group: "actions",
        title: theme === "dark" ? t("palette.cmd.lightTheme") : t("palette.cmd.darkTheme"),
        keywords: ["theme", "tema", "dark", "light", "escuro", "claro"],
        icon: theme === "dark" ? <SunIcon className={icon} /> : <MoonIcon className={icon} />,
        run: toggleTheme,
      },
      {
        id: "act:workspaces",
        group: "actions",
        title: ui.workspacesCollapsed ? t("palette.cmd.showWorkspaces") : t("palette.cmd.hideWorkspaces"),
        keywords: ["panel", "painel", "sidebar"],
        icon: <PanelIcon className={icon} />,
        run: ui.toggleWorkspaces,
      },
      {
        id: "act:explorer",
        group: "actions",
        title: ui.explorerCollapsed ? t("palette.cmd.showExplorer") : t("palette.cmd.hideExplorer"),
        keywords: ["explorer", "files", "arquivos", "panel", "painel"],
        icon: <PanelIcon className={`${icon} -scale-x-100`} />,
        run: ui.toggleExplorer,
      },
      {
        id: "act:rail",
        group: "actions",
        title: ui.railExpanded ? t("rail.collapse") : t("rail.expand"),
        keywords: ["rail", "riel", "menu", "labels", "rótulos"],
        icon: <PanelIcon className={icon} />,
        run: ui.toggleRail,
      },
      {
        id: "act:accounts",
        group: "actions",
        title: t("settings.accounts"),
        keywords: ["accounts", "login", "contas", "cuentas", "quota", "cota"],
        icon: <UserIcon className={icon} />,
        run: () => ui.setAccountsOpen(true),
      },
      {
        id: "act:settings",
        group: "actions",
        title: t("sidebar.settings"),
        keywords: ["settings", "preferences", "configurações", "preferências"],
        icon: <GearIcon className={icon} />,
        shortcut: "Ctrl+,",
        run: () => ui.setSettingsOpen(true),
      },
    );

    return list;
    // `ui` muda de identidade a cada render do store; os campos usados estão listados.
  }, [tabs, approvals, workspaces, theme, ui.workspacesCollapsed, ui.explorerCollapsed, ui.railExpanded, t]);

  // Sem busca, os grupos na ordem fixa. Com busca, uma lista só por relevância — os
  // grupos atrapalhariam: o melhor resultado tem que ser o primeiro, venha de onde vier.
  const results = useMemo(() => {
    if (query.trim()) return rank(commands, query);
    return GROUP_ORDER.flatMap((g) => commands.filter((c) => c.group === g));
  }, [commands, query]);

  useEffect(() => { setCursor(0); }, [query]);

  // A linha sob o cursor sempre visível, também navegando pelo teclado.
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const runAt = (index: number) => {
    const cmd = results[index];
    if (!cmd) return;
    close();
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (results.length ? (c + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (results.length ? (c - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(cursor);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const grouped = !query.trim();
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  return (
    <div className="fixed inset-0 z-110 flex justify-center items-start pt-[12vh] px-4">
      <div className="cc-fade absolute inset-0 bg-gray-900/30 dark:bg-black/55" onMouseDown={close} />

      <div
        ref={frameRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.open")}
        onKeyDown={onKeyDown}
        className="cc-pop relative w-full max-w-xl flex flex-col max-h-[60vh] overflow-hidden
          rounded-xl border border-gray-200 dark:border-white/10
          bg-white dark:bg-surface-raised shadow-2xl"
      >
        <div className="flex items-center gap-2.5 h-12 px-4 shrink-0 border-b border-gray-200 dark:border-white/8">
          <SearchIcon className="w-4 h-4 shrink-0 text-gray-400 dark:text-white/40" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("palette.placeholder")}
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-sm
              text-gray-900 dark:text-gray-50 placeholder:text-gray-400 dark:placeholder:text-white/30"
          />
          <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded border
            border-gray-200 dark:border-white/10 text-gray-400 dark:text-white/35">Esc</kbd>
        </div>

        <div ref={listRef} className="cc-scroll flex-1 min-h-0 py-1.5" role="listbox">
          {results.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-gray-400 dark:text-white/35">
              {t("palette.empty")}
            </p>
          )}

          {results.map((cmd, index) => {
            const header = grouped && (index === 0 || results[index - 1].group !== cmd.group);
            const selected = index === cursor;
            return (
              <div key={cmd.id}>
                {header && (
                  <div className="px-4 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-widest
                    text-gray-400 dark:text-white/30">
                    {t(`palette.group.${cmd.group}`)}
                  </div>
                )}
                <div
                  role="option"
                  aria-selected={selected}
                  data-index={index}
                  onMouseMove={() => { if (!selected) setCursor(index); }}
                  onClick={() => runAt(index)}
                  className={`mx-1.5 flex items-center gap-3 h-9 px-2.5 rounded-lg cursor-pointer
                    ${selected
                      ? "bg-gray-100 dark:bg-white/8 text-gray-900 dark:text-white"
                      : "text-gray-700 dark:text-gray-300"}`}
                >
                  <span className="shrink-0 flex text-gray-500 dark:text-white/50">{cmd.icon}</span>
                  <span className="truncate text-[13px]">{cmd.title}</span>
                  {cmd.id === `tab:${activeTab?.id}` && (
                    <span className="shrink-0 text-[10px] text-gray-400 dark:text-white/30">{t("palette.current")}</span>
                  )}
                  {cmd.subtitle && (
                    <span className="truncate text-[11px] font-mono text-gray-400 dark:text-white/30">{cmd.subtitle}</span>
                  )}
                  {cmd.shortcut && (
                    <span className="ml-auto shrink-0 text-[10px] font-mono text-gray-400 dark:text-white/30">
                      {cmd.shortcut}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-4 h-8 px-4 shrink-0 border-t border-gray-200 dark:border-white/8
          text-[10.5px] text-gray-400 dark:text-white/30">
          <span>↑↓ {t("palette.hint.move")}</span>
          <span>↵ {t("palette.hint.run")}</span>
        </div>
      </div>
    </div>
  );
}
