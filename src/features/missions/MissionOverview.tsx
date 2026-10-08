import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { agentName, agentTile } from "@/features/agents/agentTile";
import { boardKeyOfTab, useCanvasStore } from "@/features/canvas/store";
import { getMissionMemoryContextMetrics } from "@/features/memory/ipc";
import { summarize } from "@/features/memory/contextMetricsView";
import type { Task } from "@/features/runs/types";
import type { Squad } from "@/features/squads/types";
import { useTabsStore } from "@/features/tabs/store";
import { sustainedTabIds } from "@/features/terminal/activity";

import { tabsByMission, useMissionIndex } from "./groups";
import { agentStateOf, workersOf } from "./missionView";
import type { Mission, MissionDelivery, MissionSummary } from "./types";

/**
 * O topo do detalhe de uma missão (prancheta 2): Equipe e Métricas lado a lado, no estilo das
 * listas agrupadas dos Ajustes do macOS. Só apresentação: os dados são os mesmos de sempre.
 */

/** "1h 12m" (como na prancheta); `null` = ainda não começou. */
export function formatActive(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.floor(seconds / 60));
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, "0")}m`;
}

/** Dinheiro na moeda e no formato do idioma ("US$ 2,41"). */
export function formatUsd(value: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

/** "PR #112" a partir de um número ou de uma URL do GitHub. */
export function prLabel(pr: string): string {
  const n = pr.match(/(\d+)\s*$/)?.[1] ?? pr.match(/pull\/(\d+)/)?.[1];
  return n ? `PR #${n}` : pr;
}

export function prUrl(pr: string): string | null {
  return /^https?:\/\//.test(pr) ? pr : null;
}

const CAP = "px-1 pb-2 text-[11px] leading-[14px] uppercase tracking-[0.06em] text-gray-500 dark:text-white/55";
const CARD = "overflow-hidden rounded-xl bg-white dark:bg-surface shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.08)] dark:shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.05)]";

type Tone = "ok" | "warn" | "bad" | "done" | "idle";
const TONE: Record<Tone, { text: string; dot: string }> = {
  ok: { text: "text-emerald-600 dark:text-[#30d158]", dot: "bg-emerald-500 dark:bg-[#30d158] shadow-[0_0_0_2px_rgba(48,209,88,0.2)]" },
  warn: { text: "text-amber-600 dark:text-[#ff9f0a]", dot: "bg-amber-500 dark:bg-[#ff9f0a] shadow-[0_0_0_2px_rgba(255,159,10,0.2)]" },
  bad: { text: "text-red-600 dark:text-[#ff453a]", dot: "bg-red-500 dark:bg-[#ff453a]" },
  done: { text: "text-sky-600 dark:text-[#64d2ff]", dot: "bg-sky-500 dark:bg-[#64d2ff]" },
  idle: { text: "text-gray-400 dark:text-white/35", dot: "bg-gray-400 dark:bg-white/35" },
};

interface Member { key: string; name: string; sub: string; agentId: string; status: string; tone: Tone; lead: boolean }

/** Atualiza a cada `ms` enquanto montado: a atividade das terminais não tem evento. */
function useTick(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setN((v) => v + 1), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return n;
}

/** Quem está na missão: as terminais abertas dela; sem terminais, as tarefas do run; sem run, o squad. */
function useMembers(mission: Mission, tasks: Task[], squad: Squad | null, blocked: ReadonlySet<string>): Member[] {
  const { t } = useTranslation();
  const tabs = useTabsStore((s) => s.tabs);
  const index = useMissionIndex();
  const mine = useMemo(() => {
    const ids = tabsByMission(index, tabs)[mission.id] ?? [];
    return ids.map((id) => tabs.find((tab) => tab.id === id)).filter((tab) => !!tab);
  }, [index, tabs, mission.id]);
  // Funções e coroas vivem no quadro do canvas da missão.
  const board = useCanvasStore((s) => {
    const first = mine[0];
    if (!first) return "";
    const b = s.boards[boardKeyOfTab(first, s.boards)];
    return b ? JSON.stringify({ roles: b.roles ?? {}, lead: b.orchestrators ?? [] }) : "";
  });
  const tick = useTick(2000);

  return useMemo(() => {
    void tick;
    const meta = board ? (JSON.parse(board) as { roles: Record<string, string>; lead: string[] }) : { roles: {}, lead: [] };
    if (mine.length > 0) {
      const working = new Set(sustainedTabIds(Date.now()));
      const rows = mine.map((tab): Member => {
        const lead = meta.lead.includes(tab.id);
        const role = meta.roles[tab.id];
        const on = working.has(tab.id);
        return {
          key: tab.id,
          name: tab.title.split(" — ")[0],
          sub: [tab.agentLabel, lead ? t("missions.team.orchestratorTag") : role].filter(Boolean).join(" · "),
          agentId: tab.agentId,
          status: t(on ? "missions.team.working" : "missions.team.idle"),
          tone: on ? "ok" : "idle",
          lead,
        };
      });
      return rows.sort((a, b) => Number(b.lead) - Number(a.lead));
    }
    if (tasks.length > 0) {
      const lead = tasks.find((task) => task.role === "lead");
      const ordered = [...(lead ? [lead] : []), ...workersOf(tasks)];
      return ordered.map((task): Member => {
        const state = agentStateOf(task, tasks, blocked);
        const tone: Tone = state === "working" ? "ok" : state === "waiting_approval" ? "warn" : state === "failed" ? "bad" : state === "done" ? "done" : "idle";
        const name = task.role === "lead"
          ? t("missions.team.orchestrator")
          : task.functionalRole ? t(`squads.roleNames.${task.functionalRole}`, { defaultValue: task.functionalRole }) : (task.planKey ?? task.title);
        return {
          key: task.id,
          name,
          sub: [agentName(task.agentId), task.role === "lead" ? null : (task.planKey ?? task.title)].filter(Boolean).join(" · "),
          agentId: task.agentId,
          status: t(`missions.state.${state}`),
          tone,
          lead: task.role === "lead",
        };
      });
    }
    if (squad) {
      return [
        { key: "lead", name: t("missions.team.orchestrator"), sub: [agentName(squad.lead.agentId), squad.lead.model].filter(Boolean).join(" · "), agentId: squad.lead.agentId, status: t("missions.team.notStarted"), tone: "idle" as Tone, lead: true },
        ...squad.members.map((m): Member => ({
          key: m.roleId,
          name: t(`squads.roleNames.${m.roleId}`, { defaultValue: m.roleId }),
          sub: [agentName(m.agentId), m.model].filter(Boolean).join(" · "),
          agentId: m.agentId,
          status: t("missions.team.notStarted"),
          tone: "idle",
          lead: false,
        })),
      ];
    }
    return [];
  }, [mine, board, tasks, squad, blocked, tick, t]);
}

export function MissionTeamCard({ mission, tasks, squad, blocked }: {
  mission: Mission;
  tasks: Task[];
  squad: Squad | null;
  blocked: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const members = useMembers(mission, tasks, squad, blocked);
  return (
    <section aria-label={t("missions.team.title")} className="min-w-0">
      <h3 className={CAP}>{t("missions.team.title")}</h3>
      <div className={CARD}>
        {members.length === 0 && (
          <p className="px-4 py-4 text-[12.5px] text-gray-400 dark:text-white/35">{t("missions.team.empty")}</p>
        )}
        {members.map((m, i) => (
          <div key={m.key} className="relative flex h-[52px] items-center gap-3 px-3.5">
            {i > 0 && <span aria-hidden className="absolute left-14 right-0 top-0 h-px bg-black/[0.08] dark:bg-[rgba(84,84,88,0.55)]" />}
            <span aria-hidden className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-[12px] font-bold text-white shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.14)]"
              style={{ background: agentTile(m.agentId) }}>
              {m.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13.5px] leading-[18px] font-medium text-gray-900 dark:text-[#f5f5f7]">{m.name}</span>
              <span className="truncate text-[11.5px] leading-[14px] text-gray-500 dark:text-white/60">{m.sub}</span>
            </span>
            <span className={`flex shrink-0 items-center gap-1.5 text-[12px] leading-4 ${TONE[m.tone].text}`}>
              <span className={`h-[7px] w-[7px] rounded-full ${TONE[m.tone].dot}`} />
              {m.status}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Metric({ label, value, small, sub, extra, className = "" }: {
  label: string;
  value: React.ReactNode;
  small?: string;
  sub: React.ReactNode;
  extra?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-w-0 px-[18px] py-4 ${className}`}>
      <div className="text-[11.5px] leading-[14px] text-gray-500 dark:text-white/60">{label}</div>
      <div className="mt-2 truncate font-mono text-[26px] leading-[30px] font-semibold tracking-[-0.4px] tabular-nums text-gray-900 dark:text-[#f5f5f7]">
        {value}
        {small && <small className="ml-1 font-sans text-[13px] font-medium tracking-normal text-gray-500 dark:text-white/60">{small}</small>}
      </div>
      <div className="mt-1.5 flex items-center truncate text-[11.5px] leading-[14px] tabular-nums text-gray-400 dark:text-white/35">
        {sub}{extra}
      </div>
    </div>
  );
}

export function MissionMetricsCard({ summary, mission, delivery }: {
  summary: MissionSummary;
  mission: Mission;
  delivery: MissionDelivery | null;
}) {
  const { t, i18n } = useTranslation();
  const [context, setContext] = useState<{ before: number; after: number; reduction: number } | null>(null);
  useEffect(() => {
    let alive = true;
    setContext(null);
    getMissionMemoryContextMetrics(mission.id)
      .then((d) => {
        const total = summarize(Array.isArray(d?.runs) ? d.runs : []).total;
        if (alive && total) setContext({ before: total.tokensBefore, after: total.tokensAfter, reduction: total.reduction });
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [mission.id]);

  const locale = i18n.language || "pt-BR";
  const active = formatActive(summary.activeSeconds);
  const since = mission.startedAt
    ? new Date(mission.startedAt * 1000).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : null;
  const num = (n: number) => n.toLocaleString(locale);
  const line = "border-black/[0.08] dark:border-[rgba(84,84,88,0.55)]";
  const test = delivery?.testResult ?? null;

  return (
    <section aria-label={t("missions.metrics.title")} className="min-w-0">
      <h3 className={CAP}>{t("missions.metrics.title")}</h3>
      <div className={`grid grid-cols-2 ${CARD}`}>
        <Metric className={`border-r border-b ${line}`} label={t("missions.metrics.active")}
          value={active ?? "—"}
          sub={since ? t("missions.metrics.since", { time: since }) : t("missions.metrics.notStarted")} />
        <Metric className={`border-b ${line}`} label={t("missions.metrics.tests")}
          value={test ? capitalize(t(`missions.delivery.test.${test}`)) : "—"}
          sub={delivery ? t("missions.delivery.ci", { result: t(`missions.delivery.ci.${delivery.ciStatus}`) }) : t("missions.metrics.testsLater")} />
        <Metric className={`border-r ${line}`} label={t("missions.metrics.cost")}
          value={formatUsd(summary.spentUsd, locale)}
          sub={mission.budgetUsd !== null
            ? t("missions.metrics.costBudget", { budget: formatUsd(mission.budgetUsd, locale) })
            : t("missions.metrics.costSub")} />
        <Metric label={t("missions.metrics.context")}
          value={context ? <>{num(context.before)}<span className="mx-1.5 font-normal text-gray-400 dark:text-white/35">→</span>{num(context.after)}</> : "—"}
          sub={context ? t("missions.metrics.contextSub") : t("memoryContext.noData")}
          extra={context && context.reduction > 0 ? (
            <span className="ml-2 inline-flex h-[18px] items-center rounded-full bg-emerald-500/15 px-[7px] text-[11px] font-semibold text-emerald-600 dark:text-[#30d158]">
              −{context.reduction}%
            </span>
          ) : null} />
      </div>
    </section>
  );
}

export function capitalize(s: string): string {
  return s ? s[0].toLocaleUpperCase() + s.slice(1) : s;
}
