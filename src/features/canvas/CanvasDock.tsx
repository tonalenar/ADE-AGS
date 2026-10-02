import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MiniMap, useNodesInitialized, useReactFlow } from "@xyflow/react";
import { Button, CloseIcon } from "neogestify-ui-components";

import { RefreshIcon } from "@/app/icons";
import { agentIcon } from "@/features/agents/agentIcons";
import { AccountUsagePopover } from "@/features/accounts/AccountUsagePopover";
import { accountEnv, codexAccountUsage } from "@/features/accounts/ipc";
import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";
import { claudeLiveUsage } from "@/features/accounts/usage";

import { FloorBar } from "./FloorBar";

/** Qué panel está abierto sobre la barra. Uno a la vez: todos nacen en el mismo lugar. */
export type DockPanel = "layers" | "usage" | "map" | "chat" | "routines";

// ── Anillos de uso ──────────────────────────────────────────────────

/** Un anillo de progreso: el arco es `percent` (0–100) del círculo. */
export function Ring({ percent, color, size = 22, stroke = 2.6 }: { percent: number | null; color: string; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.14} strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={`${(c * value) / 100} ${c}`} opacity={percent === null ? 0.25 : 1}
        style={{ transition: "stroke-dasharray 600ms ease" }} />
    </svg>
  );
}

export const RING_COLORS = { claude: "#f08a5d", codex: "#34c79b", gemini: "#6aa5f5" } as const;

const isReal = (a: AgentAccount) => !a.id.startsWith("system:");

/**
 * Cuánto llevan gastado de su plan las cuentas principales, para los anillos de la barra:
 * Claude (la sesión de cinco horas), Codex (su ventana de cinco horas). `null` = no se
 * sabe (sin login, o la consulta falló): el anillo queda vacío y apagado, no en cero.
 *
 * Se pregunta al abrir y cada cinco minutos. La de Claude sale de la caché si es reciente
 * (preguntarle de verdad levanta la TUI entera), la de Codex es barata.
 */
function useUsageRings(accounts: AgentAccount[]): { claude: number | null; codex: number | null } {
  const [claude, setClaude] = useState<number | null>(null);
  const [codex, setCodex] = useState<number | null>(null);

  const claudeAccount = accounts.find((a) => a.agentId === "claude-code" && a.loggedIn);
  const codexAccount = accounts.find((a) => a.agentId === "codex" && a.loggedIn);

  useEffect(() => {
    let stale = false;
    const ask = async () => {
      if (claudeAccount) {
        try {
          const env = isReal(claudeAccount) ? await accountEnv(claudeAccount.id) : {};
          const live = await claudeLiveUsage(claudeAccount.id, env, false);
          if (!stale) setClaude(live.available && live.session ? live.session.percent : null);
        } catch {
          if (!stale) setClaude(null);
        }
      }
      if (codexAccount) {
        try {
          const usage = await codexAccountUsage(codexAccount.id);
          const w = usage.quota?.fiveHour ?? null;
          if (!stale) setCodex(w ? Math.round(w.utilization * 100) : null);
        } catch {
          if (!stale) setCodex(null);
        }
      }
    };
    void ask();
    const timer = window.setInterval(ask, 5 * 60 * 1000);
    return () => {
      stale = true;
      window.clearInterval(timer);
    };
  }, [claudeAccount?.id, codexAccount?.id]);

  return { claude, codex };
}

// ── Iconos ──────────────────────────────────────────────────────────

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
      className="w-[18px] h-[18px]" aria-hidden>{children}</svg>
  );
}
const LayersIcon = () => <Svg><path d="M12 3l9 5-9 5-9-5 9-5Z" /><path d="M3 13l9 5 9-5" /></Svg>;
const MapIcon = () => <Svg><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" /><path d="M9 4v14M15 6v14" /></Svg>;
const ChatIcon = () => <Svg><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.5A8 8 0 1 1 21 12Z" /></Svg>;
const ClockIcon = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
const FitIcon = () => <Svg><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" /></Svg>;

/** Un botón redondo de la barra. */
function Pill({ label, active, onClick, children, className = "" }: {
  label: string; active?: boolean; onClick: () => void; children: React.ReactNode; className?: string;
}) {
  return (
    <Button variant="custom" onClick={onClick} title={label} aria-label={label} aria-pressed={active}
      className={`cc-t h-10 min-w-10 px-2.5 flex items-center justify-center gap-1.5 rounded-full border shadow-md backdrop-blur
        ${active
          ? "bg-accent-500/15 border-accent-400/60 text-accent-600 dark:text-accent-300"
          : "bg-white/92 dark:bg-surface-raised/92 border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"}
        ${className}`}>
      {children}
    </Button>
  );
}

const popover = `pointer-events-auto absolute right-3 bottom-16 rounded-2xl overflow-hidden border border-gray-200
  dark:border-white/10 bg-white/97 dark:bg-surface-raised/97 shadow-xl`;

/**
 * La barra de abajo del canvas: andares, uso de los agentes (anillos), mapa y zoom, más el
 * chat y las rotinas. Cada botón abre su panel hacia arriba.
 *
 * Va en su propia capa, por encima de las terminales: abajo, una terminal viva la taparía.
 */
export function CanvasDock({ zoom, panel, onTogglePanel, onFit, onReset, petPercent }: {
  zoom: number;
  panel: DockPanel | null;
  onTogglePanel: (p: DockPanel) => void;
  onFit: () => void;
  onReset: () => void;
  /** Cuánto del nivel del pet está hecho (0–100): el tercer anillo. */
  petPercent: number;
}) {
  const { t } = useTranslation();
  const rf = useReactFlow();
  // El minimapa dibuja con las medidas de los nodos: antes de que React Flow las tenga,
  // saca `NaN` en sus rutas. Se muestra recién cuando están.
  const nodesReady = useNodesInitialized();
  const loaded = useAccountsStore((s) => s.loaded);
  const load = useAccountsStore((s) => s.load);
  const system = useAccountsStore((s) => s.systemAccounts);
  const custom = useAccountsStore((s) => s.accounts);
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const accounts = useMemo(() => [...system, ...custom].filter((a) => a.loggedIn), [system, custom]);
  const rings = useUsageRings(accounts);

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 20 }}>
      {panel === "layers" && (
        <div className={`${popover} p-2`}><FloorBar inline /></div>
      )}
      {panel === "usage" && <UsagePanel accounts={accounts} onClose={() => onTogglePanel("usage")} />}
      {panel === "map" && (
        <div className={`${popover} w-[17rem]`}>
          <div className="relative h-44">
            {nodesReady && (
              <MiniMap pannable zoomable nodeColor="var(--color-accent-400)" maskColor="rgba(0,0,0,0.3)"
                style={{ position: "absolute", inset: 0, margin: 0, width: "100%", height: "100%", background: "transparent" }} />
            )}
            <Button variant="custom" onClick={() => onTogglePanel("map")} aria-label={t("canvas.dock.close")}
              className="cc-t absolute right-2 top-2 z-10 w-6 h-6 flex items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/65">
              <CloseIcon className="w-3 h-3" />
            </Button>
          </div>
        </div>
      )}

      <div className="pointer-events-auto absolute right-3 bottom-3 flex items-center gap-2">
        <Pill label={t("canvas.chat.hint")} active={panel === "chat"} onClick={() => onTogglePanel("chat")}><ChatIcon /></Pill>
        <Pill label={t("canvas.routines.hint")} active={panel === "routines"} onClick={() => onTogglePanel("routines")}><ClockIcon /></Pill>
        <Pill label={t("canvas.dock.layers")} active={panel === "layers"} onClick={() => onTogglePanel("layers")}><LayersIcon /></Pill>
        <Pill label={t("canvas.dock.usage")} active={panel === "usage"} onClick={() => onTogglePanel("usage")} className="gap-1.5 px-3">
          <Ring percent={rings.claude} color={RING_COLORS.claude} />
          <Ring percent={rings.codex} color={RING_COLORS.codex} />
          <Ring percent={petPercent} color={RING_COLORS.gemini} />
        </Pill>
        <Pill label={t("canvas.dock.map")} active={panel === "map"} onClick={() => onTogglePanel("map")}><MapIcon /></Pill>

        <div className="h-10 flex items-center rounded-full border shadow-md backdrop-blur bg-white/92 dark:bg-surface-raised/92
          border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300">
          <Button variant="custom" onClick={() => rf.zoomOut({ duration: 160 })} aria-label={t("canvas.zoomOut")}
            className="cc-t w-9 h-10 flex items-center justify-center rounded-l-full text-[16px] hover:text-gray-900 dark:hover:text-white">−</Button>
          <Button variant="custom" onClick={onReset} title={t("canvas.liveHint")}
            className="cc-t w-12 h-10 text-[12px] font-semibold tabular-nums hover:text-gray-900 dark:hover:text-white">
            {Math.round(zoom * 100)}%
          </Button>
          <Button variant="custom" onClick={() => rf.zoomIn({ duration: 160 })} aria-label={t("canvas.zoomIn")}
            className="cc-t w-9 h-10 flex items-center justify-center text-[16px] hover:text-gray-900 dark:hover:text-white">+</Button>
          <span className="w-px h-5 bg-gray-200 dark:bg-white/10" />
          <Button variant="custom" onClick={onFit} aria-label={t("canvas.fit")} title={t("canvas.fit")}
            className="cc-t w-10 h-10 flex items-center justify-center rounded-r-full hover:text-gray-900 dark:hover:text-white"><FitIcon /></Button>
        </div>
      </div>
    </div>
  );
}

// ── Uso de los agentes ──────────────────────────────────────────────

/**
 * El panel "Uso dos agentes": una cuenta a la vez (con sus pestañas arriba), con el cupo
 * del plan que ya muestra la barra de estado. Una a la vez y no todas juntas porque
 * preguntarle a Claude levanta su TUI entera: abrir todas juntas lanzaría una por cuenta.
 */
function UsagePanel({ accounts, onClose }: { accounts: AgentAccount[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const current = accounts.find((a) => a.id === selected) ?? accounts[0];

  return (
    <div className={`${popover} w-[26rem] max-h-[70%] flex flex-col`}>
      <div className="flex items-center gap-1 px-3 h-10 shrink-0 border-b border-gray-200 dark:border-white/10">
        <span className="text-[13px] font-semibold text-gray-800 dark:text-gray-100">{t("canvas.dock.usageTitle")}</span>
        <span className="flex-1" />
        <Button variant="custom" onClick={() => setReload((n) => n + 1)} aria-label={t("accounts.plan.refresh")}
          className="cc-t w-7 h-7 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
          <RefreshIcon className="w-3.5 h-3.5" />
        </Button>
        <Button variant="custom" onClick={onClose} aria-label={t("canvas.dock.close")}
          className="cc-t w-7 h-7 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
          <CloseIcon className="w-3 h-3" />
        </Button>
      </div>

      {accounts.length === 0 ? (
        <p className="p-4 text-[12px] text-gray-500 dark:text-gray-400">{t("canvas.dock.noAccounts")}</p>
      ) : (
        <>
          {accounts.length > 1 && (
            <div className="flex items-center gap-1 px-2 py-1.5 shrink-0 overflow-x-auto border-b border-gray-100 dark:border-white/6">
              {accounts.map((a) => {
                const Icon = agentIcon(a.agentId, a.agentId);
                return (
                  <Button key={a.id} variant="custom" onClick={() => setSelected(a.id)} title={a.label ?? a.name}
                    className={`cc-t shrink-0 flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11px] font-medium max-w-44
                      ${a.id === current?.id
                        ? "bg-gray-100 dark:bg-white/12 text-gray-900 dark:text-white"
                        : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"}`}>
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{a.label ?? a.name}</span>
                  </Button>
                );
              })}
            </div>
          )}
          <div className="overflow-y-auto">
            {current && <AccountUsagePopover key={`${current.id}:${reload}`} account={current} onLogin={() => undefined} />}
          </div>
        </>
      )}
    </div>
  );
}
