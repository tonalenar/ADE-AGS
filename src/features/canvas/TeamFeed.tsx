import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { PermissionCard } from "@/features/runs/PermissionCard";
import { useRunsStore } from "@/features/runs/store";
import { useMissionsStore } from "@/features/missions/store";
import { ChatMarkdown } from "./LazyChatMarkdown";
import { dateLocale } from "@/i18n/dateLocale";
import { buildFeed, feedFilterOptions, filterFeed, formatMessageText, parseVigiaText, isContinuation, isVigiaMessage, mergeMessages, needsCollapse, type FeedFilter, type FeedItem, type TeamMessage, type TerminalPromptItem, type UserNote } from "./teamFeedModel";
import { answerTerminalPrompt } from "./useTerminalPrompts";

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

/** A bolinha com a inicial do agente, na cor do agente (ou cinza, se não se sabe). */
function Avatar({ name, color }: { name: string; color?: string }) {
  return (
    <span aria-hidden className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold leading-none text-white" style={{ background: color ?? "#8e8e93" }}>
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/** O aviso do Vigia: um cartão discreto com a gravidade, o que ele viu e o que fez. */
function VigiaCard({ message }: { message: TeamMessage }) {
  const { t } = useTranslation();
  const note = useMemo(() => parseVigiaText(message.text), [message.text]);
  const [open, setOpen] = useState(false);
  const long = note.body.length > 150 || (note.action?.length ?? 0) > 110;
  const tone = {
    stuck: { bar: "border-red-500/70", pill: "bg-red-500/15 text-red-600 dark:text-red-300" },
    warn: { bar: "border-amber-500/70", pill: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
    info: { bar: "border-gray-400/60 dark:border-white/25", pill: "bg-black/[0.06] text-gray-600 dark:bg-white/[0.08] dark:text-white/65" },
  }[note.tone];
  return (
    <div className={`rounded-xl border-l-[3px] bg-black/[0.025] px-3.5 py-2.5 dark:bg-white/[0.035] ${tone.bar}`}>
      <div className="mb-1 flex items-center gap-1.5 text-[11.5px] leading-4">
        <svg viewBox="0 0 24 24" aria-hidden className="h-3.5 w-3.5 shrink-0 text-gray-500 dark:text-white/55" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
        <span className="font-semibold text-gray-800 dark:text-white/85">{t("canvas.team.vigia")}</span>
        {note.label && <span className={`rounded-full px-1.5 text-[10px] font-medium leading-4 ${tone.pill}`}>{t(`canvas.team.vigiaTone.${note.tone}`)}</span>}
        {message.toName && message.toTabId !== message.fromTabId && <span title={message.toName} className="min-w-0 max-w-[40%] truncate text-gray-500 dark:text-white/50">→ {message.toName}</span>}
        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-gray-400 dark:text-white/35">{clock(message.atMs)}</span>
      </div>
      <p className={`text-[12.5px] leading-[19px] text-gray-700 dark:text-white/75 ${long && !open ? "line-clamp-3" : ""}`}>{note.body}</p>
      {note.action && (
        <p className={`mt-1.5 flex gap-1.5 text-[12px] leading-[18px] text-gray-500 dark:text-white/50 ${long && !open ? "line-clamp-2" : ""}`}>
          <span className="shrink-0 font-medium text-emerald-600 dark:text-emerald-400">{t("canvas.team.vigiaDone")}</span>
          <span>{note.action}</span>
        </p>
      )}
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="cc-t mt-1.5 text-[11.5px] font-medium text-accent-600 hover:underline dark:text-accent-300">
          {t(open ? "canvas.team.showLess" : "canvas.team.showMore")}
        </button>
      )}
    </div>
  );
}

/** O corpo da mensagem: dobrado em seis linhas quando é longo, com "Ver mais". */
function MessageBody({ text }: { text: string }) {
  const { t } = useTranslation();
  const long = needsCollapse(text);
  const [open, setOpen] = useState(false);
  const shown = useMemo(() => formatMessageText(text), [text]);
  return (
    <div className="rounded-2xl bg-gray-100 px-4 py-3 text-[13px] leading-[21px] break-words text-gray-900 dark:bg-surface-raised dark:text-[#f5f5f7] [&_.chat-md_p]:my-2.5 [&_.chat-md_ol]:my-2.5 [&_.chat-md_ol]:gap-2 [&_.chat-md_ul]:my-2.5 [&_.chat-md_ul]:gap-2 [&_.chat-md_strong]:font-semibold [&_.chat-md_strong]:text-gray-950 dark:[&_.chat-md_strong]:text-white [&_.chat-md_code]:break-all [&_.chat-md_code]:rounded-md [&_.chat-md_code]:bg-black/[0.06] [&_.chat-md_code]:px-1.5 [&_.chat-md_code]:py-0.5 [&_.chat-md_code]:text-[11.5px] [&_.chat-md_code]:font-medium [&_.chat-md_code]:text-accent-700 dark:[&_.chat-md_code]:bg-white/[0.08] dark:[&_.chat-md_code]:text-accent-300">
      <div className={long && !open ? "max-h-[9rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]" : undefined}>
        <ChatMarkdown text={shown} />
      </div>
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="cc-t mt-2 text-[12px] font-medium text-accent-600 hover:underline dark:text-accent-300">
          {t(open ? "canvas.team.showLess" : "canvas.team.showMore")}
        </button>
      )}
    </div>
  );
}

/** A linha do tempo montada e o filtro dela. O filtro mora fora da lista que rola (na barra do chat). */
export function useTeamFeed(
  missionId: string | null,
  messages: TeamMessage[],
  approvals: { approval: import("@/features/runs/types").PendingApproval; who: string }[],
  notes: UserNote[],
  prompts: TerminalPromptItem[] = [],
) {
  const all = useMemo(() => buildFeed(messages, approvals, notes, prompts), [messages, approvals, notes, prompts]);
  const [filter, setFilter] = useState<FeedFilter>("all");
  // Outra missão, outros nomes: o filtro de um agente da anterior não vale.
  useEffect(() => setFilter("all"), [missionId]);
  const options = useMemo(() => feedFilterOptions(all), [all]);
  // Um filtro que deixou de existir (o pedido foi decidido) volta para "tudo".
  const active: FeedFilter = filter === "approvals" && options.approvals === 0 ? "all" : filter;
  const items = useMemo(() => filterFeed(all, active), [all, active]);
  return { items, options, active, setFilter };
}

/** Os filtros da linha do tempo: uma faixa fixa, sempre com fundo próprio, fora da lista que rola. */
export function TeamFilterBar({ options, active, onChange }: {
  options: { names: string[]; approvals: number };
  active: FeedFilter;
  onChange: (filter: FeedFilter) => void;
}) {
  const { t } = useTranslation();
  if (options.names.length <= 1 && options.approvals === 0) return null;
  const chip = (value: FeedFilter, label: string, badge?: number) => (
    <button key={value} type="button" onClick={() => onChange(value)} aria-pressed={active === value} title={label}
      className={`cc-t flex h-6 max-w-32 shrink-0 items-center gap-1 rounded-full px-3 text-[11.5px] font-medium ${active === value
        ? "bg-accent-500 text-white"
        : "bg-black/[0.05] text-gray-600 hover:text-gray-900 dark:bg-white/[0.07] dark:text-white/65 dark:hover:text-white"}`}>
      <span className="truncate">{label}</span>
      {badge ? <span className="rounded-full bg-amber-500 px-1 text-[9.5px] font-bold leading-[14px] text-white">{badge}</span> : null}
    </button>
  );
  return (
    <div className="flex shrink-0 gap-1.5 overflow-x-auto px-4 pb-2 pt-1" role="group" aria-label={t("canvas.team.filter")}>
      {chip("all", t("canvas.team.filterAll"))}
      {options.approvals > 0 && chip("approvals", t("canvas.team.filterApprovals"), options.approvals)}
      {options.names.map((name) => chip(`agent:${name}`, name))}
    </div>
  );
}

/** A linha do tempo da equipe: o que os agentes dizem entre si, o que você mandou e o que espera decisão. */
export function TeamFeed({ items, colors = {} }: {
  items: FeedItem[];
  /** A cor de cada agente, por id de tab. */
  colors?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const decide = useRunsStore((s) => s.decideApproval);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [items.length]);
  const firstApproval = items.find((i) => i.type === "approval")?.key;
  const [answered, setAnswered] = useState<Record<string, string>>({});

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
    if (item.type === "prompt") {
      const done = answered[item.key + item.prompt.signature];
      return (
        <div key={item.key} className="rounded-xl border border-amber-500/40 bg-amber-500/[0.06] p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-amber-700 dark:text-amber-300">
            <span title={item.who} className="truncate">{t("canvas.team.permission", { who: item.who })}</span>
            <span className="ml-auto font-mono text-[11px] font-normal tabular-nums text-gray-400 dark:text-white/35">{clock(item.atMs)}</span>
          </div>
          <p className="text-[13px] font-medium leading-[18px] text-gray-900 dark:text-[#f5f5f7]">{item.prompt.title}</p>
          {item.prompt.detail && (
            <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/[0.05] px-2.5 py-2 font-mono text-[11.5px] leading-[17px] text-gray-700 dark:bg-white/[0.06] dark:text-white/75">{item.prompt.detail}</pre>
          )}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {item.prompt.choices.map((choice) => (
              <button key={choice.id} type="button" disabled={!!done}
                onClick={() => { if (answerTerminalPrompt(item.tabId, choice)) setAnswered((all) => ({ ...all, [item.key + item.prompt.signature]: choice.id })); }}
                className={`cc-t h-7 rounded-lg px-3 text-[12px] font-medium disabled:opacity-50 ${choice.id === "allow"
                  ? "bg-accent-500 text-white hover:bg-accent-600"
                  : choice.id === "deny"
                    ? "bg-red-500/15 text-red-600 hover:bg-red-500/25 dark:text-red-300"
                    : "bg-black/[0.06] text-gray-700 hover:bg-black/[0.1] dark:bg-white/[0.08] dark:text-white/80 dark:hover:bg-white/[0.14]"}`}>
                {t(`canvas.team.prompt.${choice.id}`)}
              </button>
            ))}
          </div>
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
      return <VigiaCard key={item.key} message={m} />;
    }
    const continuation = isContinuation(items[index - 1], item);
    return (
      <div key={item.key} className={`flex flex-col items-stretch ${continuation ? "-mt-3" : ""}`}>
        {!continuation && (
          <div className="mb-1 flex items-center gap-1.5 text-[11.5px] leading-4">
            <Avatar name={m.fromName} color={colors[m.fromTabId]} />
            <span title={m.fromName} className="max-w-[34%] truncate font-semibold text-gray-900 dark:text-[#f5f5f7]">{m.fromName}</span>
            <svg viewBox="0 0 16 16" aria-hidden className="h-3 w-3 shrink-0 text-gray-400 dark:text-white/40" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h10M9 4l4 4-4 4" /></svg>
            <Avatar name={m.toName} color={colors[m.toTabId]} />
            <span title={m.toName} className="max-w-[34%] truncate text-gray-600 dark:text-white/65">{m.toName}</span>
            {m.kind === "ask" && <span className="shrink-0 rounded-full bg-violet-500/15 px-1.5 text-[10px] font-medium leading-4 text-violet-600 dark:text-violet-300">{t("canvas.team.ask")}</span>}
            {m.kind === "handoff" && <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-medium leading-4 text-emerald-600 dark:text-emerald-300">{t("canvas.team.handoff")}</span>}
            <span className="ml-auto font-mono text-[11px] tabular-nums text-gray-400 dark:text-white/35">{clock(m.atMs)}</span>
          </div>
        )}
        <MessageBody text={m.text} />
      </div>
    );
  };

  return (
    <div className="space-y-6 px-0.5 pb-1 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-gray-100 [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[12px] [&_pre]:leading-4 dark:[&_pre]:bg-surface-deep [&_code]:font-mono [&_code]:text-[12px]" role="log" aria-label={t("canvas.team.title")}>
      {items.map(render)}
      <div ref={bottom} />
    </div>
  );
}
