import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useUiStore } from "@/app/uiStore";
import { agentIcon } from "@/features/agents/agentIcons";

import { openConversation } from "../chatActions";
import { XIcon } from "../chatIcons";
import { openThread } from "../structured/store";
import { TeamRoleTag } from "../team/TeamRoleTag";
import { INBOX_SHORTCUT } from "./PermissionCard";
import { askCounts, filterAsks, insideFolder, stepSelection, type AskFilter, type PendingAsk, type Risk } from "./permissionModel";
import { answerAsk, selectAsk, setAskFilter, setInboxOpen, usePendingAsks, usePermissions } from "./permissionsStore";

const FILTERS: { id: AskFilter; key: string }[] = [
  { id: "all", key: "chat.inbox.all" },
  { id: "command", key: "chat.inbox.commands" },
  { id: "edit", key: "chat.inbox.edits" },
];

const RISK_TONE: Record<Risk, string> = {
  high: "font-semibold text-red-700 dark:text-red-400",
  medium: "font-semibold text-amber-800 dark:text-amber-400",
  low: "text-gray-500 dark:text-white/45",
};

const WHAT: Record<PendingAsk["kind"], string> = {
  command: "chat.inbox.whatCommand",
  edit: "chat.inbox.whatEdit",
  network: "chat.inbox.whatNetwork",
};

/** Abre a conversa do pedido: a por protocolo, a aba da TUI ou, para a frota, a tela dela. */
export function openAskConversation(ask: PendingAsk, navigate: (to: string) => void): void {
  const ref = ask.ref;
  if (ref.source === "thread") openThread(ref.threadId);
  else if (ref.source === "tui") openConversation(ref.tabId);
  else navigate("/fleet");
}

/**
 * A caixa "Permissões" de todos os agentes (prancheta 14): cabeçalho de 52 px com "de todos os
 * agentes" e "Regras…", o filtro com as contagens, um cartão por pedido (agente, conversa, risco, o
 * que quer e o detalhe, com Negar, Abrir conversa e Permitir) e, no rodapé, a explicação e os botões
 * em lote. J/K andam entre os pedidos; ⏎ permite e N nega o que está em foco; Esc fecha.
 */
export function PermissionsInbox() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setSettingsSection = useUiStore((s) => s.setSettingsSection);
  const asks = usePendingAsks();
  const filter = usePermissions((s) => s.filter);
  const selected = usePermissions((s) => s.selected);
  const counts = useMemo(() => askCounts(asks), [asks]);
  const shown = useMemo(() => filterAsks(asks, filter), [asks, filter]);
  const ref = useRef<HTMLElement>(null);
  const current = shown.find((a) => a.id === selected) ?? null;

  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    document.getElementById(`ask-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const ids = shown.map((a) => a.id);
    if (e.key === "j" || e.key === "J" || e.key === "ArrowDown") {
      e.preventDefault();
      selectAsk(stepSelection(ids, selected, 1));
    } else if (e.key === "k" || e.key === "K" || e.key === "ArrowUp") {
      e.preventDefault();
      selectAsk(stepSelection(ids, selected, -1));
    } else if (e.key === "Escape") {
      e.preventDefault();
      setInboxOpen(false);
    } else if (current && (e.key === "n" || e.key === "N")) {
      e.preventDefault();
      answerAsk(current, "deny");
    } else if (current && e.key === "Enter" && tag !== "BUTTON") {
      e.preventDefault();
      answerAsk(current, "allow");
    }
  };

  const openRules = () => {
    setSettingsSection("permissions");
    navigate("/settings");
  };

  return (
    <aside ref={ref} tabIndex={-1} aria-label={t("chat.inbox.label")} data-permissions-inbox="" onKeyDown={onKeyDown}
      className="shrink min-w-[340px] w-[420px] h-full flex flex-col outline-none border-l border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-deep">
      <div data-tauri-drag-region className="h-[52px] shrink-0 flex items-center gap-2 px-3.5 border-b border-gray-200 dark:border-white/[0.08]">
        <b className="text-chat-heading font-semibold text-gray-900 dark:text-white">{t("chat.inbox.title")}</b>
        <span className="text-chat-caption text-gray-500 dark:text-white/45">{t("chat.inbox.subtitle")}</span>
        <span className="flex-1" data-tauri-drag-region />
        <button type="button" onClick={openRules}
          className="h-[26px] px-2 rounded-md text-chat-caption text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white">
          {t("chat.inbox.rules")}
        </button>
        <button type="button" onClick={() => setInboxOpen(false)} aria-label={t("chat.inbox.close")} title={`${t("chat.inbox.close")} (${INBOX_SHORTCUT})`}
          className="w-[26px] h-[26px] flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white">
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      <div role="group" aria-label={t("chat.inbox.filter")} className="self-start flex gap-0.5 mx-3.5 mt-2.5 mb-1.5 p-0.5 rounded-lg bg-gray-100 dark:bg-white/[0.06]">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setAskFilter(f.id)}
            className={`h-6 px-2.5 rounded-md text-chat-caption font-medium
              ${filter === f.id ? "bg-white dark:bg-surface-raised text-gray-900 dark:text-white shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-gray-500 dark:text-white/45 hover:text-gray-900 dark:hover:text-white"}`}>
            {t(f.key, { count: counts[f.id] })}
          </button>
        ))}
      </div>

      <ul className="m-0 px-2.5 py-1 list-none flex flex-col gap-2 overflow-auto cc-scroll">
        {shown.length === 0 && (
          <li className="px-2 py-8 text-center text-chat-note text-gray-400 dark:text-white/40">{t("chat.inbox.empty")}</li>
        )}
        {shown.map((ask) => <InboxItem key={ask.id} ask={ask} selected={ask.id === selected} onOpen={() => openAskConversation(ask, navigate)} />)}
      </ul>

      <div className="mt-auto px-3.5 py-2.5 border-t border-gray-200 dark:border-white/[0.08] text-chat-caption leading-normal text-gray-500 dark:text-white/45">
        {t("chat.inbox.footer", { shortcut: INBOX_SHORTCUT })}
        <div className="flex gap-1.5 mt-2">
          <button type="button" disabled={shown.length === 0} onClick={() => shown.forEach((a) => answerAsk(a, "deny"))}
            className="h-7 px-2.5 rounded-[7px] border border-gray-200 dark:border-white/10 text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-white/[0.06] disabled:opacity-50">
            {t("chat.inbox.denyAll")}
          </button>
          <button type="button" disabled={!shown.some((a) => a.risk === "low")} onClick={() => shown.filter((a) => a.risk === "low").forEach((a) => answerAsk(a, "allow"))}
            className="h-7 px-2.5 rounded-[7px] border border-gray-200 dark:border-white/10 text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-white/[0.06] disabled:opacity-50">
            {t("chat.inbox.allowLow")}
          </button>
        </div>
      </div>
    </aside>
  );
}

function InboxItem({ ask, selected, onOpen }: { ask: PendingAsk; selected: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const Icon = agentIcon(ask.agentId);
  const small = "h-7 px-2.5 rounded-[7px] border border-gray-200 dark:border-white/10 text-chat-note hover:bg-gray-100 dark:hover:bg-white/[0.06]";
  return (
    <li id={`ask-${ask.id}`} aria-current={selected ? "true" : undefined} onClick={() => selectAsk(ask.id)}
      className={`rounded-xl border bg-white dark:bg-surface-sunken px-3 py-2.5 flex flex-col gap-1.5
        ${selected ? "border-accent-500 ring-1 ring-accent-500/40" : "border-gray-200 dark:border-white/[0.08]"}`}>
      <div className="flex items-center gap-1.5 min-w-0 text-chat-caption text-gray-600 dark:text-white/55">
        <Icon className="w-4 h-4 shrink-0" />
        <b className="shrink-0 font-semibold text-gray-900 dark:text-white">{ask.agentLabel}</b>
        <span className="min-w-0 truncate">· {ask.where}</span>
        <TeamRoleTag conversation={ask.conversation} />
        <span className="flex-1" />
        <span className={`shrink-0 text-[11px] ${RISK_TONE[ask.risk]}`}>{t(`chat.risk.${ask.risk}`)}</span>
      </div>
      <div className="text-chat-note text-gray-900 dark:text-white">
        {t(ask.kind === "edit" && ask.files.some((f) => !insideFolder(f, ask.cwd)) ? "chat.inbox.whatEditOutside" : WHAT[ask.kind], { count: Math.max(1, ask.files.length) })}
      </div>
      <code title={ask.detail} className="font-mono text-chat-code text-gray-600 dark:text-white/55 whitespace-nowrap overflow-hidden text-ellipsis">{ask.detail || "—"}</code>
      <div className="flex gap-1.5">
        <button type="button" className={small} onClick={(e) => { e.stopPropagation(); answerAsk(ask, "deny"); }}>{t("chat.permission.deny")}</button>
        <button type="button" className={small} onClick={(e) => { e.stopPropagation(); onOpen(); }}>
          {ask.ref.source === "fleet" ? t("chat.inbox.openFleet") : t("chat.inbox.open")}
        </button>
        <span className="flex-1" />
        <button type="button" onClick={(e) => { e.stopPropagation(); answerAsk(ask, "allow"); }}
          className="h-7 px-3 rounded-[7px] bg-accent-600 text-white text-chat-note font-medium hover:bg-accent-700">
          {t("chat.permission.allow")}
        </button>
      </div>
    </li>
  );
}
