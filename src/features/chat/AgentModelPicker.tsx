import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { agentIcon } from "@/features/agents/agentIcons";
import { poolValue, usePools } from "@/features/accounts/pools";
import { DEFAULT_EFFORTS } from "@/features/canvas/tabTuning";
import { getRoster, refreshRosterModels } from "@/features/runs/ipc";
import type { Roster, RosterModel } from "@/features/runs/types";
import { modelsForAccount, reasoningOptions } from "@/features/squads/modelSelection";
import type { AgentInfo } from "@/features/tabs/types";
import { PopupSelect } from "@/shared/ui/PopupSelect";

import { CheckIcon, SearchIcon, StarIcon, ZapIcon } from "./chatIcons";
import { usePopover } from "./usePopover";

/** Os agentes cujo esforço vira flag (ver `withModel`). Nos outros o menu de esforço some. */
const EFFORT_AGENTS = new Set(["claude-code", "codex", "antigravity"]);

/** O agente tem esforço que vira flag? (o controle some nos outros) */
export const hasEffort = (agentId: string | null): boolean => !!agentId && EFFORT_AGENTS.has(agentId);

export interface AgentModelValue {
  agentId: string | null;
  model: string | null;
  effort: string | null;
  /** O valor do seletor de conta: id, `pool:<nome>` ou `null` (a conta principal). */
  account: string | null;
}

/** O roster é caro de montar (sonda as TUIs): um pedido por sessão do app basta para o seletor. */
let rosterRequest: Promise<Roster> | null = null;
function loadRoster(): Promise<Roster> {
  rosterRequest ??= getRoster(false).catch((e) => {
    rosterRequest = null;
    throw e;
  });
  return rosterRequest;
}

function useRoster(enabled: boolean): Roster | null {
  const [roster, setRoster] = useState<Roster | null>(null);
  useEffect(() => {
    if (!enabled || roster) return;
    loadRoster().then(setRoster).catch(() => undefined);
  }, [enabled, roster]);
  return roster;
}

function catalogOf(roster: Roster | null, agentId: string | null, account: string | null): RosterModel[] {
  const agent = roster?.agents.find((a) => a.agentId === agentId);
  const pool = account?.startsWith("pool:") ?? false;
  return modelsForAccount(agent, pool ? null : account, pool);
}

// ── Favoritos (preferência desta máquina) ─────────────────────────────

const FAV_KEY = "cc-chat-favorites";
const favKey = (agentId: string, model: string) => `${agentId}:${model}`;

function loadFavorites(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveFavorites(list: string[]): void {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(list));
  } catch {
    /* sem favoritos lembrados, o seletor funciona igual */
  }
}

interface Row {
  agent: AgentInfo;
  /** `null` = o modelo padrão do agente. */
  model: string | null;
  label: string;
}

/**
 * O seletor da prancheta 3 (o do T3 Code): popover de 360×346 com o trilho de agentes (e os
 * favoritos) à esquerda e a lista de modelos com busca à direita; a conta no rodapé (do ADE).
 */
export function AgentModelPicker({ agents, value, onChange, shortcutHint, showAccount = true, disabled = false, placement = "above" }: {
  agents: AgentInfo[];
  value: AgentModelValue;
  onChange: (next: AgentModelValue) => void;
  shortcutHint?: string;
  /** Numa conversa aberta a conta não muda (a sessão mora na pasta da conta). */
  showAccount?: boolean;
  disabled?: boolean;
  /** Para onde o popover abre: em cima (o composer, no pé da tela) ou embaixo (uma linha das Configurações). */
  placement?: "above" | "below";
}) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const loaded = useRoster(true);
  const [fresh, setFresh] = useState<Roster | null>(null);
  const roster = fresh ?? loaded;
  const [tab, setTab] = useState<string | "fav">(value.agentId ?? agents[0]?.id ?? "fav");
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>(loadFavorites);
  const agent = agents.find((a) => a.id === value.agentId) ?? agents[0] ?? null;
  const tabAgent = tab === "fav" ? agent : agents.find((a) => a.id === tab) ?? agent;
  const pools = usePools(tabAgent?.id ?? null);
  const current = catalogOf(roster, agent?.id ?? null, value.account);
  const modelLabel = value.model ? current.find((m) => m.id === value.model)?.label || value.model : t("chat.model.default");

  // Os provedores do OpenCode mudam fora do app (`opencode auth login`): ao abrir, sonda de novo.
  useEffect(() => {
    if (!open || tabAgent?.id !== "opencode") return;
    let alive = true;
    refreshRosterModels("opencode", value.agentId === "opencode" && value.account && !value.account.startsWith("pool:") ? value.account : null)
      .then((next) => { if (alive) { rosterRequest = Promise.resolve(next); setFresh(next); } })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [open, tabAgent?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- só ao abrir ou trocar de aba

  useEffect(() => { if (open && agent) setTab(agent.id); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- só ao abrir

  const rows: Row[] = useMemo(() => {
    const ofAgent = (a: AgentInfo): Row[] => [
      { agent: a, model: null, label: t("chat.model.default") },
      ...catalogOf(roster, a.id, a.id === value.agentId ? value.account : null).map((m) => ({ agent: a, model: m.id, label: m.label || m.id })),
    ];
    const base = tab === "fav"
      ? agents.flatMap(ofAgent).filter((r) => r.model && favorites.includes(favKey(r.agent.id, r.model)))
      : tabAgent ? ofAgent(tabAgent) : [];
    const q = query.trim().toLowerCase();
    return q ? base.filter((r) => `${r.label} ${r.model ?? ""}`.toLowerCase().includes(q)) : base;
  }, [agents, roster, tab, tabAgent, favorites, query, value.agentId, value.account, t]);

  const toggleFav = (r: Row) => {
    if (!r.model) return;
    const key = favKey(r.agent.id, r.model);
    const next = favorites.includes(key) ? favorites.filter((f) => f !== key) : [...favorites, key];
    setFavorites(next);
    saveFavorites(next);
  };

  if (!agent) return <span className="px-2 text-chat-note text-gray-400 dark:text-white/40">{t("chat.agent.none")}</span>;
  const Icon = agentIcon(agent.id, agent.command);

  return (
    <div ref={ref} className="relative min-w-0 max-w-full">
      <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => !disabled && setOpen(!open)} title={shortcutHint} disabled={disabled}
        className={`flex max-w-full items-center gap-1.5 h-7 px-2 rounded-lg whitespace-nowrap text-chat-ui font-medium text-gray-900/85 dark:text-white/85
          hover:bg-gray-100 dark:hover:bg-white/[0.07] ${open ? "bg-gray-100 dark:bg-white/[0.07]" : ""}`}>
        <Icon className="w-4 h-4 shrink-0" />
        <span className="min-w-0 truncate max-w-52">{modelLabel}</span>
      </button>

      {open && (
        <div role="dialog" aria-label={t("chat.picker.title")}
          className={`absolute right-0 ${placement === "below" ? "top-full mt-2" : "bottom-full mb-2"} z-50 flex w-[360px] h-[346px] overflow-hidden rounded-lg
            bg-white/[0.92] dark:bg-surface-raised/[0.92] backdrop-blur-xl
            shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]`}>
          <div role="tablist" aria-label={t("chat.picker.agents")}
            className="w-11 shrink-0 flex flex-col items-center gap-1 p-1 cc-scroll bg-gray-50/60 dark:bg-white/[0.01]">
            <RailButton label={t("chat.picker.favorites")} on={tab === "fav"} onClick={() => setTab("fav")}>
              <StarIcon filled className="w-5 h-5 text-amber-500" />
            </RailButton>
            <span aria-hidden="true" className="w-5 h-px my-0.5 bg-gray-200 dark:bg-white/10" />
            {agents.map((a) => {
              const AIcon = agentIcon(a.id, a.command);
              return (
                <RailButton key={a.id} label={a.label} on={tab === a.id} onClick={() => setTab(a.id)}>
                  <AIcon className="w-6 h-6" />
                </RailButton>
              );
            })}
          </div>

          <div className="flex-1 min-w-0 flex flex-col border-l border-gray-200 dark:border-white/[0.08] bg-gray-50/80 dark:bg-white/[0.01]">
            <label className="flex items-center gap-2 h-10 shrink-0 px-3 border-b border-gray-200 dark:border-white/[0.08] text-gray-500 dark:text-white/45">
              <SearchIcon className="w-3.5 h-3.5" />
              <span className="sr-only">{t("chat.picker.search")}</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("chat.picker.search")} autoFocus
                className="flex-1 min-w-0 bg-transparent outline-none text-chat-ui text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-white/35" />
            </label>
            <div role="listbox" aria-label={t("chat.picker.models")} className="flex-1 min-h-0 cc-scroll p-1">
              {rows.map((r, i) => {
                const group = r.agent.id === "opencode" && r.model?.includes("/") ? r.model.split("/")[0] : null;
                const prevGroup = i > 0 && rows[i - 1].agent.id === "opencode" ? rows[i - 1].model?.split("/")[0] : undefined;
                const showGroup = !!group && (i === 0 || prevGroup !== group || !rows[i - 1].model?.includes("/"));
                const RIcon = agentIcon(r.agent.id, r.agent.command);
                const selected = r.agent.id === agent.id && r.model === value.model;
                const fav = !!r.model && favorites.includes(favKey(r.agent.id, r.model));
                return (
                  <Fragment key={`${r.agent.id}:${r.model ?? ""}`}>
                  {showGroup && <div className="px-2 pt-2 pb-1 text-chat-caption font-medium uppercase tracking-wide text-gray-500 dark:text-white/45">{group}</div>}
                  <div
                    className={`flex items-center gap-1.5 px-2 py-1.5 rounded ${selected ? "bg-gray-200/60 dark:bg-white/10" : "hover:bg-gray-200/40 dark:hover:bg-white/[0.06]"}`}>
                    <button type="button" role="option" aria-selected={selected}
                      onClick={() => {
                        onChange({ agentId: r.agent.id, model: r.model, effort: r.agent.id === value.agentId ? value.effort : null, account: r.agent.id === value.agentId ? value.account : null });
                        setOpen(false);
                      }}
                      className="flex-1 min-w-0 flex flex-col items-start text-left">
                      <span className="w-full truncate text-chat-ui text-gray-900 dark:text-white">{r.label}</span>
                      <span className="flex items-center gap-1 text-chat-caption text-gray-500 dark:text-white/45">
                        <RIcon className="w-3 h-3" />{r.agent.label}
                      </span>
                    </button>
                    {r.model && (
                      <button type="button" onClick={() => toggleFav(r)} aria-pressed={fav}
                        aria-label={t("chat.picker.favorite", { name: r.label })} title={t("chat.picker.favorite", { name: r.label })}
                        className={`w-[22px] h-[22px] flex items-center justify-center rounded ${fav ? "text-amber-500" : "text-gray-300 dark:text-white/25 hover:text-gray-600 dark:hover:text-white/60"}`}>
                        <StarIcon filled={fav} className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {selected && <CheckIcon className="w-3.5 h-3.5 shrink-0 text-gray-900 dark:text-white" />}
                  </div>
                  </Fragment>
                );
              })}
              {tab === "fav" && rows.length === 0 && (
                <p className="my-6 text-center text-chat-note text-gray-500 dark:text-white/45">{t("chat.picker.noFavorites")}</p>
              )}
              {roster && tab === "opencode" && !query.trim() && catalogOf(roster, "opencode", value.agentId === "opencode" ? value.account : null).length === 0 && (
                <p className="px-2 py-3 text-chat-note text-gray-500 dark:text-white/45">
                  {t("chat.picker.opencodeNone")} <code className="font-mono">opencode auth login</code>
                </p>
              )}
              {!roster && tab !== "fav" && <p className="px-2 py-3 text-chat-note text-gray-400 dark:text-white/40">{t("chat.picker.loading")}</p>}
            </div>
            {showAccount && <div className="flex items-center gap-2 h-9 shrink-0 px-3 border-t border-gray-200 dark:border-white/[0.08] text-chat-caption text-gray-500 dark:text-white/45">
              <span className="flex-1">{t("chat.picker.account")}</span>
              {tabAgent && (
                <PopupSelect value={tabAgent.id === value.agentId ? value.account ?? "" : ""} aria-label={t("chat.picker.account")}
                  onChange={(e) => onChange({ agentId: tabAgent.id, model: tabAgent.id === value.agentId ? value.model : null, effort: tabAgent.id === value.agentId ? value.effort : null, account: e.target.value || null })}
                  className="max-w-44 text-chat-caption">
                  <option value="">{t("accounts.system")}</option>
                  {(roster?.agents.find((a) => a.agentId === tabAgent.id)?.accounts ?? []).filter((a) => a.accountId !== null).map((a) => (
                    <option key={a.accountId!} value={a.accountId!}>{a.label ?? a.name}</option>
                  ))}
                  {pools.map((p) => <option key={p.id} value={poolValue(p.name)}>{t("chat.picker.pool", { name: p.name })}</option>)}
                </PopupSelect>
              )}
            </div>}
          </div>
        </div>
      )}
    </div>
  );
}

function RailButton({ label, on, onClick, children }: { label: string; on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={on} aria-label={label} title={label} onClick={onClick}
      className={`relative w-9 h-9 shrink-0 flex items-center justify-center rounded-md ${on ? "bg-gray-200/70 dark:bg-white/10" : "hover:bg-gray-200/50 dark:hover:bg-white/10"}`}>
      {children}
      {on && <span aria-hidden="true" className="absolute -right-1 top-2 w-[3px] h-5 rounded-full bg-accent-600" />}
    </button>
  );
}

/**
 * O esforço, num menu à parte (a palavra cinza ao lado do modelo, como no T3). Só aparece nos
 * agentes em que o esforço vira flag.
 */
export function EffortMenu({ agentId, model, account, value, onChange, disabled = false, placement = "above" }: {
  agentId: string | null;
  model: string | null;
  account: string | null;
  value: string | null;
  onChange: (effort: string | null) => void;
  disabled?: boolean;
  /** Para onde o menu abre: em cima (o composer) ou embaixo (um formulário perto do topo). */
  placement?: "above" | "below";
}) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const roster = useRoster(!!agentId && EFFORT_AGENTS.has(agentId));
  if (!agentId || !EFFORT_AGENTS.has(agentId)) return null;
  const levels = reasoningOptions(model, catalogOf(roster, agentId, account));
  const efforts = levels.length > 0 ? levels : DEFAULT_EFFORTS;
  const label = (e: string) => t(`chat.effort.${e}`, { defaultValue: e });
  return (
    <div ref={ref} className="relative -ml-1.5">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => !disabled && setOpen(!open)} disabled={disabled}
        className={`h-7 px-1.5 rounded-lg whitespace-nowrap text-chat-ui font-medium text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/[0.07] ${open ? "bg-gray-100 dark:bg-white/[0.07]" : ""}`}>
        {value ? label(value) : t("chat.effort.default")}
      </button>
      {open && (
        <div role="menu" aria-label={t("chat.picker.effort")}
          className={`absolute right-0 ${placement === "below" ? "top-full mt-2" : "bottom-full mb-2"} z-50 w-[220px] p-1 rounded-lg bg-white/[0.92] dark:bg-surface-raised/[0.92] backdrop-blur-xl
            shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]`}>
          <div className="px-2 pt-1.5 pb-1 text-chat-caption font-medium text-gray-500 dark:text-white/45">{t("chat.picker.effort")}</div>
          {[null, ...efforts].map((e) => (
            <button key={e ?? "default"} type="button" role="menuitemradio" aria-checked={value === e}
              onClick={() => { onChange(e); setOpen(false); }}
              className="w-full flex items-center gap-2 min-h-7 px-2 rounded text-left text-chat-ui text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-white/[0.07]">
              <span className="flex-1">{e ? label(e) : t("chat.effort.default")}</span>
              {value === e && <CheckIcon className="w-3.5 h-3.5" />}
            </button>
          ))}
          {agentId === "codex" && (
            <div className="flex items-center gap-2 min-h-7 px-2 mt-1 pt-1 border-t border-gray-200 dark:border-white/10 text-chat-note text-gray-500 dark:text-white/45">
              <ZapIcon className="w-3.5 h-3.5" /><span className="flex-1">{t("chat.picker.fast")}</span><span>{t("chat.picker.fastOff")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
