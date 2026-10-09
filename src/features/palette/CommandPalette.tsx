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
import { boardKeyOfTab, setWorkMode, useCanvasStore } from "@/features/canvas/store";

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

/** Tecla de atalho (kbd): mono, pastilha discreta. */
const KBD = "font-mono text-[11px] leading-4 px-1.5 py-px rounded-[5px] bg-gray-100 dark:bg-white/[0.08] text-gray-500 dark:text-white/[0.55] whitespace-nowrap";

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
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const canvasKey = activeTab ? boardKeyOfTab(activeTab) : null;
  const canvasOn = useCanvasStore((s) => (canvasKey ? s.modes[canvasKey] === "canvas" : false));

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
        // "Codex — C:\…": o caminho já vai no subtítulo; no título fica só o nome.
        title: tab.title.split(" — ")[0],
        subtitle: tab.cwd,
        keywords: [tab.title, tab.agentLabel, tab.cwd],
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
        subtitle: t("palette.workspaceMeta", { count: ws.tabCount }),
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

    if (canvasKey) {
      list.push({
        id: "act:canvas",
        group: "actions",
        title: canvasOn ? t("palette.cmd.tabsMode") : t("palette.cmd.canvas"),
        keywords: ["canvas", "abas", "tabs", "nodes", "conectar", "connect"],
        icon: <StackIcon className={icon} />,
        run: () => { setWorkMode(canvasKey, canvasOn ? "tabs" : "canvas"); navigate("/workspace"); },
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
  }, [tabs, approvals, workspaces, theme, canvasKey, canvasOn, ui.workspacesCollapsed, ui.explorerCollapsed, ui.railExpanded, t]);

  // Sem busca, os grupos na ordem fixa. Com busca, uma lista só por relevância — os
  // grupos atrapalhariam: o melhor resultado tem que ser o primeiro, venha de onde vier.
  const results = useMemo(() => {
    if (query.trim()) return rank(commands, query);
    return GROUP_ORDER.flatMap((g) => commands.filter((c) => c.group === g));
  }, [commands, query]);

  useEffect(() => { setCursor(0); }, [query]);
  // A lista pode encolher sem a busca mudar (uma aba fecha, uma aprovação some): o cursor não fica no vazio.
  useEffect(() => { setCursor((c) => (c >= results.length ? Math.max(0, results.length - 1) : c)); }, [results.length]);

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

  return (
    <div className="fixed inset-0 z-110 flex justify-center items-start pt-[12vh] px-4">
      <div className="cc-fade absolute inset-0 bg-gray-900/30 dark:bg-black/55" onMouseDown={close} />

      <div
        ref={frameRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.open")}
        onKeyDown={onKeyDown}
        className="cc-pop relative w-full max-w-[560px] flex flex-col max-h-[60vh] overflow-hidden
          rounded-xl border border-black/[0.08] dark:border-white/[0.08]
          bg-white/90 dark:bg-surface-raised/75 backdrop-blur-[30px] backdrop-saturate-[180%]
          shadow-[0_0_0_0.5px_rgba(255,255,255,0.08),0_10px_30px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.3)]"
      >
        <div className="flex items-center gap-3 h-14 px-[18px] shrink-0 border-b border-black/[0.08] dark:border-white/[0.08]">
          <SearchIcon className="w-[18px] h-[18px] shrink-0 text-gray-500 dark:text-white/55" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("palette.placeholder")}
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[18px] leading-6
              text-gray-900 dark:text-gray-50 placeholder:text-gray-400 dark:placeholder:text-white/30"
          />
          <kbd className={KBD}>Esc</kbd>
        </div>

        <div ref={listRef} className="cc-scroll flex-1 min-h-0 py-2" role="listbox">
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
                  <div className="px-[18px] pt-2.5 pb-1 text-[11px] leading-[14px] uppercase tracking-[0.06em]
                    text-gray-500 dark:text-white/[0.32]">
                    {t(`palette.group.${cmd.group}`)}
                  </div>
                )}
                <div
                  role="option"
                  aria-selected={selected}
                  data-index={index}
                  onMouseMove={() => { if (!selected) setCursor(index); }}
                  onClick={() => runAt(index)}
                  className={`mx-1.5 flex items-center gap-2.5 h-9 px-3 rounded-md cursor-pointer
                    ${selected
                      ? "bg-accent-500/15 text-gray-900 dark:bg-accent-500/20 dark:text-white"
                      : "text-gray-700 dark:text-gray-300"}`}
                >
                  <span className={`shrink-0 flex ${selected ? "text-accent-600 dark:text-accent-400" : "text-gray-500 dark:text-white/50"}`}>{cmd.icon}</span>
                  <span className="truncate text-[13px]">{cmd.title}</span>
                  {cmd.id === `tab:${activeTab?.id}` && (
                    <span className="shrink-0 text-[11px] text-gray-400 dark:text-white/30">{t("palette.current")}</span>
                  )}
                  {cmd.subtitle && (
                    <span className="truncate text-[11px] font-mono text-gray-400 dark:text-white/30">{cmd.subtitle}</span>
                  )}
                  {cmd.shortcut && (
                    <span className="ml-auto shrink-0 font-mono text-[12px] tabular-nums text-gray-400 dark:text-white/[0.45]">
                      {cmd.shortcut}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-4 h-9 px-4 shrink-0 border-t border-black/[0.08] dark:border-white/[0.08]
          text-[12px] leading-4 text-gray-500 dark:text-white/[0.45]">
          <span className="flex items-center gap-1.5"><kbd className={KBD}>↑↓</kbd>{t("palette.hint.move")}</span>
          <span className="flex items-center gap-1.5"><kbd className={KBD}>↵</kbd>{t("palette.hint.run")}</span>
        </div>
      </div>
    </div>
  );
}
