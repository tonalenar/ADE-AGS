import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MiniMap, useNodesInitialized, useReactFlow } from "@xyflow/react";
import { Button, CloseIcon } from "neogestify-ui-components";

import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";

import { useVigiaSwitch } from "@/features/missions/vigiaSwitch";

import { unreadOf, useUnreadStore } from "./chatUnread";
import { FloorBar } from "./FloorBar";
import { RING_COLORS, Ring } from "./Ring";
import { UsageBoard } from "./UsageBoard";
import { startUsagePolling, useUsageStore } from "./usageStore";

/** Qué panel está abierto sobre la barra. Uno a la vez: todos nacen en el mismo lugar. */
export type DockPanel = "layers" | "map" | "chat" | "routines" | "design";

// ── Anillos de uso ──────────────────────────────────────────────────

/**
 * Cuánto llevan gastado de su plan las cuentas principales, para los anillos de la barra:
 * Claude (la sesión de cinco horas), Codex (su ventana de cinco horas) y Antigravity (el
 * modelo más gastado). `null` = no se sabe (sin login, o la consulta falló): el anillo queda
 * vacío y apagado, no en cero. El de Antigravity solo se dibuja si hay una cuenta con datos.
 * Los datos los mantiene `usageStore`, siempre vivo mientras el canvas está abierto.
 */
function useUsageRings(): { claude: number | null; codex: number | null; antigravity: number | null } {
  const claude = useUsageStore((st) => {
    for (const live of Object.values(st.claude)) if (live.available && live.session) return live.session.percent;
    return null;
  });
  const codex = useUsageStore((st) => {
    for (const e of Object.values(st.codex)) {
      const w = e.usage?.quota?.fiveHour;
      if (w) return Math.round(w.utilization * 100);
    }
    return null;
  });
  const antigravity = useUsageStore((st) => {
    for (const e of Object.values(st.antigravity)) if (e.meters && e.meters.length > 0) return e.meters[0].percent;
    return null;
  });
  return { claude, codex, antigravity };
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
const EyeIcon = () => <Svg><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></Svg>;
const ClockIcon = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
const DesignIcon = () => <Svg><rect x="3" y="4" width="8" height="16" rx="1.5" /><rect x="13" y="4" width="8" height="9" rx="1.5" /></Svg>;
const FitIcon = () => <Svg><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" /></Svg>;

/** Material translúcido de la barra y los paneles (estilo macOS). */
const material = "bg-white/85 dark:bg-surface-raised/75 backdrop-blur-[30px] backdrop-saturate-[180%] shadow-[0_0_0_0.5px_rgba(255,255,255,0.08),0_10px_30px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.3)]";
const hairline = "border-black/[0.08] dark:border-white/[0.08]";

/** Un botón de la barra: pastilla de 34px; la activa queda en gris elevado. */
function Pill({ label, active, onClick, children, className = "" }: {
  label: string; active?: boolean; onClick: () => void; children: React.ReactNode; className?: string;
}) {
  return (
    <Button variant="custom" onClick={onClick} title={label} aria-label={label} aria-pressed={active}
      className={`cc-t h-[34px] min-w-[34px] px-2 flex items-center justify-center gap-1.5 rounded-[9px]
        ${active
          ? "bg-gray-200 text-gray-900 dark:bg-surface-overlay dark:text-white"
          : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white"}
        ${className}`}>
      {children}
    </Button>
  );
}

/** Separador hairline entre grupos de la barra. */
const Sep = () => <span aria-hidden className="w-px h-[22px] mx-1.5 bg-black/10 dark:bg-white/[0.08]" />;

const popover = `pointer-events-auto absolute right-3 bottom-16 rounded-xl overflow-hidden border ${hairline} ${material}`;

/**
 * La barra de abajo del canvas: andares, uso de los agentes (anillos), mapa y zoom, más el
 * chat y las rotinas. Cada botón abre su panel hacia arriba.
 *
 * Va en su propia capa, por encima de las terminales: abajo, una terminal viva la taparía.
 */
export function CanvasDock({ zoom, panel, onTogglePanel, onOpenChat, onFit, onReset, petPercent, hasDesign, designUnseen }: {
  zoom: number;
  panel: DockPanel | null;
  onTogglePanel: (p: DockPanel) => void;
  /** Abre el chat (sin alternar). */
  onOpenChat: () => void;
  onFit: () => void;
  onReset: () => void;
  /** Cuánto del nivel del pet está hecho (0–100): el tercer anillo. */
  petPercent: number;
  /** Hay al menos un diseño en este canvas: sin diseño no hay botón (ni espacio muerto). */
  hasDesign: boolean;
  /** Apareció un diseño nuevo que el usuario aún no abrió: el botón lleva un indicador. */
  designUnseen: boolean;
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
  const rings = useUsageRings();
  // Un aviso del sistema pidió abrir el chat: se abre si no lo estaba.
  const jump = useUnreadStore((s) => s.jump);
  useEffect(() => {
    // `onOpenChat` abre y no alterna: en desarrollo el efecto corre dos veces y alternar lo cerraría.
    if (jump) onOpenChat();
    // La función cambia en cada render del canvas: solo importa el pedido.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);
  const unreadTotal = useUnreadStore((s) => Object.values(s.unread).reduce((n, by) => n + unreadOf(by), 0));
  const vigiaOn = useVigiaSwitch((s) => s.enabled);
  const toggleVigia = useVigiaSwitch((s) => s.toggle);
  useEffect(() => startUsagePolling(accounts), [accounts]);
  const [usageOpen, setUsageOpen] = useState(readUsageOpen);
  useEffect(() => writeUsageOpen(usageOpen), [usageOpen]);
  const toggleUsage = () => setUsageOpen((v) => !v);

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 20 }}>
      {panel === "layers" && (
        <div className={`${popover} p-2`}><FloorBar inline /></div>
      )}
      {usageOpen && panel === null && <UsagePanel accounts={accounts} onClose={toggleUsage} />}
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

      <div className={`pointer-events-auto absolute right-3 bottom-3 flex items-center gap-1 h-[52px] px-2.5 rounded-2xl ${material}`}>
        <Pill label={t("canvas.chat.hint")} active={panel === "chat"} onClick={() => onTogglePanel("chat")} className="relative">
          <ChatIcon />
          {unreadTotal > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[17px] h-[17px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold
              leading-[17px] text-center shadow">{unreadTotal > 9 ? "9+" : unreadTotal}</span>
          )}
        </Pill>
        <Pill label={t(vigiaOn ? "canvas.vigia.on" : "canvas.vigia.off")} active={vigiaOn} onClick={toggleVigia}><EyeIcon /></Pill>
        {hasDesign && (
          <Pill label={t("canvas.design.hint")} active={panel === "design"} onClick={() => onTogglePanel("design")} className="relative">
            <DesignIcon />
            {designUnseen && <span aria-label={t("canvas.design.unseen")} className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-accent-500 ring-2 ring-white dark:ring-surface-raised animate-pulse" />}
          </Pill>
        )}
        <Sep />
        <Pill label={t("canvas.routines.hint")} active={panel === "routines"} onClick={() => onTogglePanel("routines")}><ClockIcon /></Pill>
        <Pill label={t("canvas.dock.layers")} active={panel === "layers"} onClick={() => onTogglePanel("layers")}><LayersIcon /></Pill>
        <Sep />
        <Pill label={t("canvas.dock.usage")} active={usageOpen && panel === null}
          // Com outro painel aberto o de Uso não aparece: o clique fecha o outro e mostra o de Uso.
          onClick={() => { if (panel !== null) { onTogglePanel(panel); setUsageOpen(true); } else toggleUsage(); }} className="gap-1 px-2">
          <Ring percent={rings.claude} color={RING_COLORS.claude} />
          <Ring percent={rings.codex} color={RING_COLORS.codex} />
          {rings.antigravity !== null && <Ring percent={rings.antigravity} color={RING_COLORS.gemini} />}
          <Ring percent={petPercent} color={RING_COLORS.gemini} />
        </Pill>
        <Sep />
        <Pill label={t("canvas.dock.map")} active={panel === "map"} onClick={() => onTogglePanel("map")}><MapIcon /></Pill>

        <div className="flex items-center gap-0.5 h-[34px] ml-0.5 p-0.5 rounded-[9px] bg-gray-100 dark:bg-surface-raised text-gray-600 dark:text-gray-300">
          <Button variant="custom" onClick={() => rf.zoomOut({ duration: 160 })} aria-label={t("canvas.zoomOut")}
            className="cc-t w-[30px] h-[30px] flex items-center justify-center rounded-[7px] text-[16px] leading-none hover:bg-white dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white">−</Button>
          <Button variant="custom" onClick={onReset} title={t("canvas.liveHint")}
            className="cc-t min-w-[50px] h-[30px] px-1 rounded-[7px] font-mono text-[12px] tabular-nums text-gray-900 dark:text-gray-50 hover:bg-white dark:hover:bg-white/[0.06]">
            {Math.round(zoom * 100)}%
          </Button>
          <Button variant="custom" onClick={() => rf.zoomIn({ duration: 160 })} aria-label={t("canvas.zoomIn")}
            className="cc-t w-[30px] h-[30px] flex items-center justify-center rounded-[7px] text-[16px] leading-none hover:bg-white dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white">+</Button>
          <span aria-hidden className="w-px h-4 mx-0.5 bg-black/10 dark:bg-white/[0.08]" />
          <Button variant="custom" onClick={onFit} aria-label={t("canvas.fit")} title={t("canvas.fit")}
            className="cc-t w-[30px] h-[30px] flex items-center justify-center rounded-[7px] hover:bg-white dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white"><FitIcon /></Button>
        </div>
      </div>
    </div>
  );
}

// ── Uso de los agentes ──────────────────────────────────────────────

/**
 * El panel "Uso dos agentes": el cupo del plan de cada cuenta con sesión — anillo, barras
 * por límite y cuándo se reinicia (ver `UsageBoard`).
 */
function UsagePanel({ accounts, onClose }: { accounts: AgentAccount[]; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={`${popover} w-[22rem] max-h-[calc(100%-5rem)] flex flex-col`}>
      <div className={`flex items-center gap-1 pl-4 pr-2 h-11 shrink-0 border-b ${hairline}`}>
        <span className="text-[13px] font-semibold tracking-[-0.01em] text-gray-800 dark:text-gray-100">{t("canvas.dock.usageTitle")}</span>
        <span className="flex-1" />
        <Button variant="custom" onClick={onClose} aria-label={t("canvas.dock.close")}
          className="cc-t w-7 h-7 flex items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-700 dark:hover:text-gray-200">
          <CloseIcon className="w-3 h-3" />
        </Button>
      </div>
      <div className="overflow-y-auto">
        <UsageBoard accounts={accounts} />
      </div>
    </div>
  );
}

// El panel de uso nace abierto y recuerda si se lo cerró: las cuotas se ven siempre, salvo que se pida lo contrario.
const OPEN_KEY = "cc.canvas.usageOpen";
function readUsageOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}
function writeUsageOpen(open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    /* sin almacenamiento: no se recuerda */
  }
}
