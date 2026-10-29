import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { WindowLights } from "@/app/WindowLights";
import { useUiStore } from "@/app/uiStore";
import { agentIcon } from "@/features/agents/agentIcons";

import { newConversation, openConversation } from "./chatActions";
import { CheckIcon, ChevronRightIcon, ClockIcon, FilterIcon, FolderPlusIcon, NewChatIcon, PullRequestIcon, SearchIcon, SettingsIcon, SidebarIcon, UsageIcon } from "./chatIcons";
import { projectTone, type ChatProject, type ConversationCard } from "./chatModel";
import { useChatLive } from "./liveStore";
import { reopenSettled, settleConversation, snoozeConversation, unsnoozeConversation, useShelf } from "./shelf";
import { usePopover } from "./usePopover";

/** A largura da sidebar (a padrão do T3 Code). */
export const CHAT_SIDEBAR_W = 256;

export interface FolderDiff {
  added: number;
  removed: number;
}

/**
 * A sidebar de conversas da prancheta 1: busca com filtro por pasta, adicionar projeto e nova
 * conversa; as conversas abertas em cartões de 78 px (pasta e status, título, branch e alterações,
 * agente); as pastas fechadas em "Concluídas"; e no rodapé Configurações, Pull requests e Uso.
 */
export function ChatSidebar({ cards, closed, diffs, selectedId, onCollapse, onAddProject, onReopen }: {
  cards: ConversationCard[];
  /** As pastas fechadas que o painel lembra (reabrir traz os agentes de volta). */
  closed: ChatProject[];
  /** O `+/−` não commitado de cada pasta. */
  diffs: Record<string, FolderDiff>;
  selectedId: string | null;
  onCollapse: () => void;
  onAddProject: () => void;
  onReopen: (cwd: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setSettingsSection = useUiStore((s) => s.setSettingsSection);
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [closedOpen, setClosedOpen] = useState(false);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const snoozedIds = useShelf((s) => s.snoozed);
  const settled = useShelf((s) => s.settled);
  const folders = useMemo(() => [...new Set(cards.map((c) => c.project))], [cards]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cards.filter((c) => (!folder || c.project === folder) && (!q || `${c.title} ${c.project} ${c.agentLabel}`.toLowerCase().includes(q)));
  }, [cards, query, folder]);
  const shown = matches.filter((c) => !snoozedIds.includes(c.tabId));
  const snoozed = matches.filter((c) => snoozedIds.includes(c.tabId));
  const doneCount = settled.length + closed.length;

  return (
    <aside aria-label={t("chat.sidebar.label")} style={{ width: CHAT_SIDEBAR_W }}
      className="shrink-0 h-full flex flex-col bg-gray-50 dark:bg-black border-r border-gray-200 dark:border-white/[0.08]">
      <div data-tauri-drag-region className="h-[52px] shrink-0 flex items-center gap-2 pl-5 select-none">
        <WindowLights />
        <IconButton label={t("chat.sidebar.collapse")} onClick={onCollapse} className="ml-3.5"><SidebarIcon className="w-4 h-4" /></IconButton>
        <span data-tauri-drag-region className="text-[14px] font-semibold text-gray-900 dark:text-white">
          ADE <span className="font-medium text-gray-500 dark:text-white/50">AGS</span>
        </span>
      </div>

      <div className="flex items-center gap-0.5 px-2 pt-1 pb-2">
        <label className="flex-1 min-w-0 flex items-center gap-2 h-8 px-2 rounded-md text-[14px] font-medium
          text-gray-500 dark:text-white/45 hover:bg-white dark:hover:bg-white/[0.05] focus-within:ring-1 focus-within:ring-accent-500/70">
          <SearchIcon className="w-4 h-4 shrink-0" />
          <span className="sr-only">{t("chat.sidebar.search")}</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("chat.sidebar.search")}
            className="flex-1 min-w-0 bg-transparent outline-none text-gray-900 dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/45" />
        </label>
        <FolderFilter folders={folders} value={folder} onChange={setFolder} />
        <IconButton label={t("chat.sidebar.addProject")} onClick={onAddProject}><FolderPlusIcon className="w-4 h-4" /></IconButton>
        <IconButton label={t("chat.sidebar.new")} onClick={newConversation}><NewChatIcon className="w-4 h-4" /></IconButton>
      </div>

      <nav aria-label={t("chat.sidebar.active")} className="flex-1 min-h-0 cc-scroll px-2 flex flex-col gap-0.5">
        {cards.length === 0 && (
          <p className="px-2 py-6 text-center text-[13px] text-gray-400 dark:text-white/40">{t("chat.sidebar.empty")}</p>
        )}
        {shown.map((card) => (
          <Card key={card.tabId} card={card} diff={diffs[card.cwd]} selected={card.tabId === selectedId} />
        ))}
      </nav>

      {snoozed.length > 0 && (
        <div className="px-2 pt-1">
          <SectionHeader label={t("chat.sidebar.snoozed")} count={snoozed.length} open={snoozedOpen} onToggle={() => setSnoozedOpen(!snoozedOpen)} />
          {snoozedOpen && (
            <div className="max-h-40 cc-scroll flex flex-col">
              {snoozed.map((c) => (
                <SlimRow key={c.tabId} name={c.project} title={c.title} agentId={c.agentId}
                  onOpen={() => { unsnoozeConversation(c.tabId); openConversation(c.tabId); }} />
              ))}
            </div>
          )}
        </div>
      )}

      {doneCount > 0 && (
        <div className="px-2 pt-1">
          <SectionHeader label={t("chat.sidebar.closed")} count={doneCount} open={closedOpen} onToggle={() => setClosedOpen(!closedOpen)} />
          {closedOpen && (
            <div className="max-h-48 cc-scroll flex flex-col">
              {settled.map((e) => (
                <SlimRow key={e.id} name={e.cwd.split(/[\\/]/).filter(Boolean).pop() ?? e.cwd} title={e.title} agentId={e.agentId}
                  onOpen={() => reopenSettled(e.id)} />
              ))}
              {closed.map((p) => (
                <button key={p.cwd} type="button" onClick={() => onReopen(p.cwd)} title={t("chat.sidebar.reopen", { name: p.name })}
                  className="h-9 shrink-0 flex items-center gap-2.5 px-2.5 rounded-md text-left text-[13px] text-gray-600 dark:text-white/60 hover:bg-white dark:hover:bg-white/[0.05]">
                  <ProjectBadge name={p.name} size="sm" muted />
                  <span className="flex-1 truncate">{p.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-0.5 px-2 pt-1.5 pb-2.5">
        <FooterButton label={t("sidebar.settings")} onClick={() => navigate("/settings")}><SettingsIcon className="w-4 h-4" /></FooterButton>
        <FooterButton label={t("chat.sidebar.pullRequests")} onClick={() => navigate("/forge")}><PullRequestIcon className="w-4 h-4" /></FooterButton>
        <FooterButton label={t("chat.sidebar.usage")} onClick={() => { setSettingsSection("accounts"); navigate("/settings"); }}><UsageIcon className="w-4 h-4" /></FooterButton>
      </div>
    </aside>
  );
}

/** O quadradinho com a inicial da pasta. */
export function ProjectBadge({ name, size = "md", muted = false }: { name: string; size?: "sm" | "md"; muted?: boolean }) {
  const box = size === "sm" ? "w-3.5 h-3.5 text-[8px] rounded" : "w-4 h-4 text-[9px] rounded";
  return (
    <span aria-hidden="true"
      className={`${box} shrink-0 inline-flex items-center justify-center font-bold text-white ${projectTone(name)} ${muted ? "opacity-50 grayscale" : ""}`}>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function Card({ card, diff, selected }: { card: ConversationCard; diff: FolderDiff | undefined; selected: boolean }) {
  const { t } = useTranslation();
  const Icon = agentIcon(card.agentId);
  const phase = useChatLive((s) => s.phase[card.tabId]);
  const question = useChatLive((s) => s.question[card.tabId]);
  const awaiting = useChatLive((s) => card.tabId in s.awaiting);
  const status = awaiting
    ? { label: t("chat.status.approval"), tone: "text-amber-700 dark:text-amber-400", dash: "3 3" }
    : question
      ? { label: t("chat.status.question"), tone: "text-amber-700 dark:text-amber-400", dash: "3 3" }
      : phase === "working"
        ? { label: t("chat.status.working"), tone: "text-accent-700 dark:text-accent-400", dash: "5 3" }
        : null;
  return (
    <div role="button" tabIndex={0} onClick={() => openConversation(card.tabId)} aria-current={selected ? "page" : undefined} title={card.cwd}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openConversation(card.tabId); } }}
      className={`group w-full h-[78px] shrink-0 flex flex-col justify-between px-2 py-2.5 rounded-md text-left cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-accent-500/70
        ${selected
          ? "bg-white dark:bg-white/[0.11] ring-1 ring-inset ring-gray-200 dark:ring-transparent"
          : "hover:bg-white dark:hover:bg-white/[0.08]"}`}>
      <span className="flex items-center gap-1.5 text-[12px] text-gray-600 dark:text-white/55">
        <ProjectBadge name={card.project} />
        <span className="flex-1 min-w-0 truncate">{card.project}</span>
        {status && (
          <span className={`shrink-0 inline-flex items-center gap-1 group-hover:hidden ${status.tone}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeDasharray={status.dash} className="w-3.5 h-3.5" aria-hidden="true"><circle cx="12" cy="12" r="9" /></svg>
            {status.label}
          </span>
        )}
        <span className="hidden group-hover:inline-flex shrink-0 items-center gap-0.5 -my-1">
          <CardAction label={t("chat.sidebar.snooze")} onClick={() => snoozeConversation(card.tabId)}><ClockIcon className="w-3.5 h-3.5" /></CardAction>
          <CardAction label={t("chat.sidebar.settle")} onClick={() => { void settleConversation(card.tabId); }}><CheckIcon className="w-3.5 h-3.5" /></CardAction>
        </span>
      </span>
      <span className="truncate text-[14px] font-medium text-gray-900 dark:text-white">{card.title}</span>
      <span className="flex items-center gap-2 text-[12px] text-gray-500 dark:text-white/45">
        <span className="truncate max-w-[110px] font-mono text-[11px]">{card.branch ?? card.agentLabel}</span>
        {diff && diff.added + diff.removed > 0 && (
          <span className="font-mono text-[11px]">
            <span className="text-emerald-700 dark:text-emerald-400">+{diff.added}</span>{" "}
            <span className="text-red-700 dark:text-red-400">−{diff.removed}</span>
          </span>
        )}
        <span className="flex-1" />
        <Icon className="w-3.5 h-3.5 shrink-0" />
      </span>
    </div>
  );
}

/** Um botão no canto do cartão (Adiar, Concluir): não abre a conversa. */
function CardAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="w-6 h-6 flex items-center justify-center rounded text-gray-500 dark:text-white/50 hover:bg-gray-200/70 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white">
      {children}
    </button>
  );
}

function SectionHeader({ label, count, open, onToggle }: { label: string; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle}
      className="w-full flex items-center h-8 px-2 rounded-md text-[13px] font-medium text-gray-500 dark:text-white/45 hover:bg-white dark:hover:bg-white/[0.05]">
      <span className="flex-1 text-left">{label}</span>
      <span className="tabular-nums mr-1.5">{count}</span>
      <ChevronRightIcon className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`} />
    </button>
  );
}

/** Linha fina das seções de baixo (Adiadas, Concluídas): pasta apagada até o hover, título e agente. */
function SlimRow({ name, title, agentId, onOpen }: { name: string; title: string; agentId: string; onOpen: () => void }) {
  const Icon = agentIcon(agentId);
  return (
    <button type="button" onClick={onOpen} title={title}
      className="group h-9 shrink-0 flex items-center gap-2.5 px-2.5 rounded-md text-left text-[13px] text-gray-600 dark:text-white/60 hover:bg-white dark:hover:bg-white/[0.05]">
      <span className="opacity-40 grayscale group-hover:opacity-100 group-hover:grayscale-0"><ProjectBadge name={name} size="sm" /></span>
      <span className="flex-1 truncate">{title}</span>
      <Icon className="w-3.5 h-3.5 shrink-0 opacity-60" />
    </button>
  );
}

function FolderFilter({ folders, value, onChange }: { folders: string[]; value: string | null; onChange: (v: string | null) => void }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="relative">
      <IconButton label={t("chat.sidebar.filter")} onClick={() => setOpen(!open)} active={value !== null}><FilterIcon className="w-4 h-4" /></IconButton>
      {open && (
        <div role="menu" aria-label={t("chat.sidebar.filter")}
          className="absolute left-0 top-full mt-1 z-50 w-56 max-h-72 cc-scroll p-1 rounded-lg text-[13px]
            bg-white/95 dark:bg-surface-raised/95 backdrop-blur-xl shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_16px_40px_-18px_rgba(0,0,0,0.55)]">
          <MenuItem on={value === null} onClick={() => { onChange(null); setOpen(false); }}>{t("chat.sidebar.allFolders")}</MenuItem>
          {folders.map((f) => (
            <MenuItem key={f} on={value === f} onClick={() => { onChange(f); setOpen(false); }}>
              <ProjectBadge name={f} size="sm" /> <span className="truncate">{f}</span>
            </MenuItem>
          ))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={on} onClick={onClick}
      className={`w-full flex items-center gap-2 min-h-7 px-2 rounded text-left text-gray-800 dark:text-white/85
        ${on ? "bg-gray-100 dark:bg-white/10" : "hover:bg-gray-100 dark:hover:bg-white/[0.07]"}`}>
      {children}
    </button>
  );
}

export function IconButton({ label, onClick, children, className = "", active = false }: {
  label: string; onClick: () => void; children: React.ReactNode; className?: string; active?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} data-tauri-drag-region="false" aria-pressed={active || undefined}
      className={`w-7 h-7 shrink-0 flex items-center justify-center rounded-md
        ${active ? "bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white" : "text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white"} ${className}`}>
      {children}
    </button>
  );
}

function FooterButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className="w-8 h-8 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white">
      {children}
    </button>
  );
}
