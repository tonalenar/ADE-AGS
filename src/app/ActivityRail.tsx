import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Button, Badge, BoxIcon, ChevronLeftIcon, ChevronRightIcon, ClockIcon, CloudIcon, GearIcon,
  NetworkIcon, SearchIcon, Tooltip,
} from "neogestify-ui-components";

import { useUiStore } from "@/app/uiStore";
import { PALETTE_SHORTCUT, shortcutForPath } from "@/app/shortcuts";
import { AccountCircleIcon, CanvasGridIcon, MissionCheckIcon, PullRequestIcon, SquadPeopleIcon } from "@/app/icons";
import { useRunsStore } from "@/features/runs/store";

/** Larguras do riel. O `AppShell` usa as mesmas para medir o cabeçalho lateral. */
export const RAIL_COMPACT_W = 48;
export const RAIL_EXPANDED_W = 212;

/** "Marketplace · Ctrl+Shift+M". O tooltip é onde alguém descobre o atalho. */
function withShortcut(label: string, path: string | null): string {
  const hint = path ? shortcutForPath(path) : null;
  return hint ? `${label} · ${hint}` : label;
}

function RailButton({
  label, path, active, badge, badgeVariant = "accent", expanded, hint, onClick, children,
}: {
  label: string;
  path: string | null;
  active: boolean;
  badge?: number;
  /** `warning` = alguém está esperando por você, não uma simples contagem. */
  badgeVariant?: "accent" | "warning";
  expanded: boolean;
  /** Texto à direita no modo expandido (o atalho da paleta, por exemplo). */
  hint?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const button = (
    <Button variant="custom"
      onClick={onClick}
      aria-label={label}
      className={`cc-t relative flex items-center h-9 rounded-[10px] shrink-0 p-0
        ${expanded ? "w-full gap-2.5 px-2.5 justify-start" : "w-9 justify-center"}
        ${active
          // Ativo: el ícono se pinta de accent sobre un fondo accent suave (como el riel de Xcode).
          ? "text-accent-600 dark:text-accent-400 bg-accent-500/15"
          : "text-gray-400 dark:text-white/40 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200/60 dark:hover:bg-white/[0.06]"}`}
    >
      <span className="shrink-0 flex">{children}</span>
      {expanded && (
        <span className={`truncate text-[12.5px] ${active ? "font-medium" : ""}`}>{label}</span>
      )}
      {expanded && hint && (
        <span className="ml-auto shrink-0 text-[10px] font-mono text-gray-400 dark:text-white/30">{hint}</span>
      )}
      {badge != null && badge > 0 && (
        <Badge
          variant={badgeVariant}
          size="sm"
          pill
          className={`pointer-events-none ${expanded ? "ml-auto" : "absolute -top-0.5 -right-0.5"}
            ${badgeVariant === "warning" ? "animate-pulse" : ""}`}
        >
          {badge}
        </Badge>
      )}
    </Button>
  );

  // Expandido, o nome já está escrito: o tooltip só repetiria. Fica o atalho, se houver.
  if (expanded) {
    const shortcut = path ? shortcutForPath(path) : null;
    return shortcut
      ? <Tooltip content={shortcut} placement="right" delay={600}>{button}</Tooltip>
      : button;
  }
  return (
    <Tooltip content={withShortcut(label, path)} placement="right" delay={400}>
      {button}
    </Tooltip>
  );
}

/** Separa os grupos. Expandido mostra o nome do grupo; compacto, só um traço. */
function RailGroup({ label, expanded }: { label: string; expanded: boolean }) {
  if (!expanded) {
    return <span className="my-1.5 w-5 h-px shrink-0 bg-gray-300 dark:bg-white/[0.08]" aria-hidden />;
  }
  return (
    <span className="w-full px-2.5 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.06em]
      text-gray-400 dark:text-white/30 select-none">
      {label}
    </span>
  );
}

/**
 * O riel da esquerda.
 *
 * É o primeiro que se vê, e por isso leva o que é dos AGENTES: uma IDE abre com a árvore
 * de arquivos porque o primeiro é o código; aqui o primeiro é o que está rodando.
 *
 * As seções vão em três grupos — agentes, orquestração, recursos — para que sete ícones
 * não se leiam como uma fila só. Com `railExpanded` cada uma ganha o nome ao lado.
 */
export function ActivityRail({ agentCount, width }: { agentCount: number; width: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const collapsed = useUiStore((s) => s.workspacesCollapsed);
  const toggleWorkspaces = useUiStore((s) => s.toggleWorkspaces);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setAccountsOpen = useUiStore((s) => s.setAccountsOpen);
  const accountsOpen = useUiStore((s) => s.accountsOpen);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const expanded = useUiStore((s) => s.railExpanded);
  const toggleRail = useUiStore((s) => s.toggleRail);
  // Permissões que um agente da frota está esperando: se veem de qualquer tela.
  const pendingApprovals = useRunsStore((s) => s.approvals.length);

  // `startsWith` e não `===`: senão /marketplace/registries não acende Marketplace.
  const on = (path: string) => pathname.startsWith(path) && path !== "/";
  const icon = "w-[18px] h-[18px]";

  return (
    <nav
      style={{ width }}
      className={`flex flex-col gap-0.5 shrink-0 py-1.5 overflow-y-auto overflow-x-hidden
        transition-[width] duration-150
        ${expanded ? "items-stretch px-2" : "items-center"}
        bg-gray-100/80 dark:bg-surface-deep/75 backdrop-blur-xl
        border-r border-gray-200 dark:border-white/[0.08]`}
    >
      <RailButton
        label={expanded ? t("palette.short") : t("palette.open")}
        path={null}
        active={paletteOpen}
        expanded={expanded}
        hint={PALETTE_SHORTCUT}
        onClick={() => setPaletteOpen(true)}
      >
        <SearchIcon className={icon} />
      </RailButton>

      <RailGroup label={t("rail.group.agents")} expanded={expanded} />

      <RailButton
        label={t("rail.workspaces")}
        path={null}
        active={!collapsed}
        expanded={expanded}
        badge={agentCount}
        onClick={toggleWorkspaces}
      >
        <CanvasGridIcon className={icon} />
      </RailButton>

      <RailButton label={t("sidebar.sessions")} path="/sessions" active={on("/sessions")} expanded={expanded}
        onClick={() => navigate("/sessions")}>
        <ClockIcon className={icon} />
      </RailButton>

      <RailButton
        label={pendingApprovals > 0 && !expanded ? t("rail.fleetWaiting", { count: pendingApprovals }) : t("sidebar.fleet")}
        path="/fleet"
        active={on("/fleet")}
        expanded={expanded}
        badge={pendingApprovals}
        badgeVariant="warning"
        onClick={() => navigate("/fleet")}
      >
        <NetworkIcon className={icon} />
      </RailButton>

      <RailGroup label={t("rail.group.orchestration")} expanded={expanded} />

      <RailButton label={t("sidebar.missions")} path="/missions" active={on("/missions")} expanded={expanded}
        onClick={() => navigate("/missions")}>
        <MissionCheckIcon className={icon} />
      </RailButton>

      <RailButton label={t("sidebar.squads")} path="/squads" active={on("/squads")} expanded={expanded}
        onClick={() => navigate("/squads")}>
        <SquadPeopleIcon className={icon} />
      </RailButton>

      <RailGroup label={t("rail.group.resources")} expanded={expanded} />

      <RailButton label={t("sidebar.forge")} path="/forge" active={on("/forge")} expanded={expanded}
        onClick={() => navigate("/forge")}>
        <PullRequestIcon className={icon} />
      </RailButton>

      <RailButton label={t("sidebar.skills")} path="/skills" active={on("/skills")} expanded={expanded}
        onClick={() => navigate("/skills")}>
        <BoxIcon className={icon} />
      </RailButton>

      <RailButton label={t("sidebar.marketplace")} path="/marketplace" active={on("/marketplace")} expanded={expanded}
        onClick={() => navigate("/marketplace")}>
        <CloudIcon className={icon} />
      </RailButton>

      <div className="flex-1 min-h-2" />

      {/* Contas é sua própria tela, não um atalho para uma seção de Configurações: é o
          que vai crescer conforme entrarem serviços que pedem login. */}
      <RailButton
        label={t("settings.accounts")}
        path={null}
        active={accountsOpen}
        expanded={expanded}
        onClick={() => setAccountsOpen(true)}
      >
        <AccountCircleIcon className={icon} />
      </RailButton>

      <RailButton label={t("sidebar.settings")} path="/settings" active={settingsOpen} expanded={expanded}
        onClick={() => setSettingsOpen(true)}>
        <GearIcon className={icon} />
      </RailButton>

      <RailButton
        label={expanded ? t("rail.collapse") : t("rail.expand")}
        path={null}
        active={false}
        expanded={expanded}
        onClick={toggleRail}
      >
        {expanded ? <ChevronLeftIcon className={icon} /> : <ChevronRightIcon className={icon} />}
      </RailButton>
    </nav>
  );
}
