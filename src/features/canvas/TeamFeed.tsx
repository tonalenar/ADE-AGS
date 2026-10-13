import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { PermissionCard } from "@/features/runs/PermissionCard";
import { useRunsStore } from "@/features/runs/store";
import { useMissionsStore } from "@/features/missions/store";
import { ChatMarkdown } from "./ChatMarkdown";
import { dateLocale } from "@/i18n/dateLocale";
import { buildFeed, isVigiaMessage, mergeMessages, type FeedItem, type TeamMessage, type UserNote } from "./teamFeedModel";

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
    // Uma leitura por vez: duas em voo usariam o mesmo `afterId` e trariam as mesmas linhas.
    let inflight = false;
    let again = false;
    const pull = () => {
      if (inflight) { again = true; return; }
      inflight = true;
      invoke<TeamMessage[]>("mission_messages", { missionId, afterId: last.current })
        .then((fresh) => {
          if (!alive || fresh.length === 0) return;
          last.current = Math.max(last.current, ...fresh.map((m) => m.id));
          setMessages((all) => mergeMessages(all, fresh));
        })
        .catch(() => {})
        .finally(() => {
          inflight = false;
          if (again && alive) { again = false; pull(); }
        });
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

/** A linha do tempo da equipe: o que os agentes dizem entre si, o que você mandou e o que espera decisão. */
export function TeamFeed({ messages, approvals, notes }: {
  messages: TeamMessage[];
  approvals: { approval: import("@/features/runs/types").PendingApproval; who: string }[];
  notes: UserNote[];
}) {
  const { t } = useTranslation();
  const decide = useRunsStore((s) => s.decideApproval);
  const items = useMemo(() => buildFeed(messages, approvals, notes), [messages, approvals, notes]);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [items.length]);
  const firstApproval = items.find((i) => i.type === "approval")?.key;

  const render = (item: FeedItem) => {
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
    if (isVigiaMessage(m)) {
      return (
        <div key={item.key} className="flex items-baseline gap-1.5 px-1 text-[11.5px] leading-4 text-gray-500 dark:text-white/50">
          <span className="shrink-0 font-semibold">{t("canvas.team.vigia")}</span>
          {m.toName && <span title={m.toName} className="max-w-[30%] shrink-0 truncate">→ {m.toName}</span>}
          <span title={m.text} className="min-w-0 flex-1 truncate italic">{m.text}</span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-gray-400 dark:text-white/35">{clock(m.atMs)}</span>
        </div>
      );
    }
    return (
      <div key={item.key} className="flex flex-col items-stretch">
        <div className="mb-1 flex items-center gap-1.5 text-[11.5px] leading-4">
          <span title={m.fromName} className="max-w-[40%] truncate font-semibold text-gray-900 dark:text-[#f5f5f7]">{m.fromName}</span>
          <span aria-hidden className="text-gray-400 dark:text-white/40">{m.kind === "ask" ? "?→" : "→"}</span>
          <span title={m.toName} className="max-w-[40%] truncate text-gray-600 dark:text-white/65">{m.toName}</span>
          <span className="ml-auto font-mono text-[11px] tabular-nums text-gray-400 dark:text-white/35">{clock(m.atMs)}</span>
        </div>
        <div className="rounded-[14px] bg-gray-100 px-3.5 py-2 text-[13px] leading-[19px] break-words text-gray-900 dark:bg-surface-raised dark:text-[#f5f5f7]">
          <ChatMarkdown text={m.text} />
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-gray-100 [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[12px] [&_pre]:leading-4 dark:[&_pre]:bg-surface-deep [&_code]:font-mono [&_code]:text-[12px]" role="log" aria-label={t("canvas.team.title")}>
      {items.map(render)}
      <div ref={bottom} />
    </div>
  );
}
