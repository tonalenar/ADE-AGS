import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { PermissionCard } from "@/features/runs/PermissionCard";
import { useRunsStore } from "@/features/runs/store";
import { useMissionsStore } from "@/features/missions/store";
import { ChatMarkdown } from "./ChatMarkdown";
import { dateLocale } from "@/i18n/dateLocale";
import { buildFeed, feedFilterOptions, filterFeed, isContinuation, needsCollapse, type FeedFilter, type FeedItem, type TeamMessage, type UserNote } from "./teamFeedModel";

const clock = (ms: number) => new Date(ms).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });

/** As mensagens entre os agentes da missão: lê o histórico e acompanha as novas (`cc-peer-message`). */
export function useTeamMessages(missionId: string | null): TeamMessage[] {
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const last = useRef(0);
  useEffect(() => {
    setMessages([]);
    last.current = 0;
    if (!missionId) return;
    let alive = true;
    const pull = () => {
      invoke<TeamMessage[]>("mission_messages", { missionId, afterId: last.current })
        .then((fresh) => {
          if (!alive || fresh.length === 0) return;
          last.current = fresh[fresh.length - 1].id;
          setMessages((all) => [...all, ...fresh]);
        })
        .catch(() => {});
    };
    pull();
    const off = listen("cc-peer-message", () => setTimeout(pull, 150));
    const timer = window.setInterval(pull, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      void off.then((fn) => fn());
    };
  }, [missionId]);
  return messages;
}

/** Os pedidos de permissão da frota que esperam nesta missão (as tarefas do run ativo dela). */
export function useMissionApprovals(missionId: string | null) {
  const approvals = useRunsStore((s) => s.approvals);
  const tasks = useRunsStore((s) => s.tasks);
  const runId = useMissionsStore((s) => s.missions.find((m) => m.id === missionId)?.activeRunId ?? null);
  return useMemo(() => {
    if (!runId) return [];
    return approvals.flatMap((approval) => {
      const task = tasks.find((t) => t.id === approval.taskId);
      return task && task.runId === runId ? [{ approval, who: task.title }] : [];
    });
  }, [approvals, tasks, runId]);
}

/** A bolinha com a inicial do agente, na cor do agente (ou cinza, se não se sabe). */
function Avatar({ name, color }: { name: string; color?: string }) {
  return (
    <span aria-hidden className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold leading-none text-white" style={{ background: color ?? "#8e8e93" }}>
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/** O corpo da mensagem: dobrado em seis linhas quando é longo, com "Ver mais". */
function MessageBody({ text }: { text: string }) {
  const { t } = useTranslation();
  const long = needsCollapse(text);
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-[14px] bg-gray-100 px-3.5 py-2 text-[13px] leading-[19px] break-words text-gray-900 dark:bg-surface-raised dark:text-[#f5f5f7]">
      <div className={long && !open ? "max-h-[7.5rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]" : undefined}>
        <ChatMarkdown text={text} />
      </div>
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="cc-t mt-1 text-[12px] font-medium text-accent-600 hover:underline dark:text-accent-300">
          {t(open ? "canvas.team.showLess" : "canvas.team.showMore")}
        </button>
      )}
    </div>
  );
}

/** A linha do tempo da equipe: o que os agentes dizem entre si, o que você mandou e o que espera decisão. */
export function TeamFeed({ messages, approvals, notes, colors = {} }: {
  messages: TeamMessage[];
  approvals: { approval: import("@/features/runs/types").PendingApproval; who: string }[];
  notes: UserNote[];
  /** A cor de cada agente, por id de tab. */
  colors?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const decide = useRunsStore((s) => s.decideApproval);
  const all = useMemo(() => buildFeed(messages, approvals, notes), [messages, approvals, notes]);
  const [filter, setFilter] = useState<FeedFilter>("all");
  const options = useMemo(() => feedFilterOptions(all), [all]);
  // Um filtro que deixou de existir (o pedido foi decidido) volta para "tudo".
  const active: FeedFilter = filter === "approvals" && options.approvals === 0 ? "all" : filter;
  const items = useMemo(() => filterFeed(all, active), [all, active]);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [items.length]);
  const firstApproval = items.find((i) => i.type === "approval")?.key;

  const chip = (value: FeedFilter, label: string, badge?: number) => (
    <button key={value} type="button" onClick={() => setFilter(value)} aria-pressed={active === value} title={label}
      className={`cc-t flex h-[22px] max-w-32 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-medium ${active === value
        ? "bg-accent-500 text-white"
        : "bg-black/[0.05] text-gray-600 hover:text-gray-900 dark:bg-white/[0.07] dark:text-white/65 dark:hover:text-white"}`}>
      <span className="truncate">{label}</span>
      {badge ? <span className="rounded-full bg-amber-500 px-1 text-[9.5px] font-bold leading-[14px] text-white">{badge}</span> : null}
    </button>
  );

  const render = (item: FeedItem, index: number) => {
    if (item.type === "user") {
      return (
        <div key={item.key} className="flex flex-col items-end">
          <span className="mb-1 text-[11px] text-gray-500 dark:text-white/50">{t("canvas.team.you", { name: item.toName })}</span>
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-accent-500 px-3.5 py-2 text-[13px] leading-[19px] text-white">{item.text}</div>
          <span className="mt-1 font-mono text-[11px] tabular-nums text-gray-400 dark:text-white/35">{clock(item.atMs)}</span>
        </div>
      );
    }
    if (item.type === "approval") {
      return (
        <div key={item.key} className="rounded-xl border border-amber-500/40 bg-amber-500/[0.06] p-2">
          <div className="mb-1 flex items-center gap-1.5 px-1 text-[11.5px] font-semibold text-amber-700 dark:text-amber-300">
            <span title={item.who} className="truncate">{t("canvas.team.permission", { who: item.who })}</span>
            <span className="ml-auto font-mono text-[11px] font-normal tabular-nums text-gray-400 dark:text-white/35">{clock(item.atMs)}</span>
          </div>
          <PermissionCard approval={item.approval} focused={item.key === firstApproval} onDecide={(allow, remember) => void decide(item.approval.id, allow, remember)} />
        </div>
      );
    }
    const m = item.message;
    const continuation = isContinuation(items[index - 1], item);
    return (
      <div key={item.key} className={`flex flex-col items-stretch ${continuation ? "-mt-2.5" : ""}`}>
        {!continuation && (
          <div className="mb-1 flex items-center gap-1.5 text-[11.5px] leading-4">
            <Avatar name={m.fromName} color={colors[m.fromTabId]} />
            <span title={m.fromName} className="max-w-[34%] truncate font-semibold text-gray-900 dark:text-[#f5f5f7]">{m.fromName}</span>
            <svg viewBox="0 0 16 16" aria-hidden className="h-3 w-3 shrink-0 text-gray-400 dark:text-white/40" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h10M9 4l4 4-4 4" /></svg>
            <Avatar name={m.toName} color={colors[m.toTabId]} />
            <span title={m.toName} className="max-w-[34%] truncate text-gray-600 dark:text-white/65">{m.toName}</span>
            {m.kind === "ask" && <span className="shrink-0 rounded-full bg-violet-500/15 px-1.5 text-[10px] font-medium leading-4 text-violet-600 dark:text-violet-300">{t("canvas.team.ask")}</span>}
            <span className="ml-auto font-mono text-[11px] tabular-nums text-gray-400 dark:text-white/35">{clock(m.atMs)}</span>
          </div>
        )}
        <MessageBody text={m.text} />
      </div>
    );
  };

  return (
    <div className="space-y-4 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-gray-100 [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[12px] [&_pre]:leading-4 dark:[&_pre]:bg-surface-deep [&_code]:font-mono [&_code]:text-[12px]" role="log" aria-label={t("canvas.team.title")}>
      {(options.names.length > 1 || options.approvals > 0) && (
        <div className="sticky top-0 z-10 -mx-1 flex gap-1 overflow-x-auto bg-white/90 px-1 pb-1.5 backdrop-blur dark:bg-surface/90" role="group" aria-label={t("canvas.team.filter")}>
          {chip("all", t("canvas.team.filterAll"))}
          {options.approvals > 0 && chip("approvals", t("canvas.team.filterApprovals"), options.approvals)}
          {options.names.map((name) => chip(`agent:${name}`, name))}
        </div>
      )}
      {items.map(render)}
      <div ref={bottom} />
    </div>
  );
}
