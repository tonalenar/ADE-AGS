import { EffortLevel } from "./EffortLevel";
import { Fragment, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { agentIcon } from "@/features/agents/agentIcons";
import { poolValue, usePools } from "@/features/accounts/pools";
import { DEFAULT_EFFORTS } from "@/features/canvas/tabTuning";
import type { PickDraft } from "@/features/compare/types";
import { getRoster, refreshRosterModels } from "@/features/runs/ipc";
import type { Roster, RosterModel } from "@/features/runs/types";
import { claudeEffortLevels, effectiveModelForEffort, findModel, modelsForAccount, reasoningOptions } from "@/features/squads/modelSelection";
import type { AgentInfo } from "@/features/tabs/types";
import { PopupSelect } from "@/shared/ui/PopupSelect";
import { matrixProviderForAgent, readHarnessCapability, useHarnessCapability, type HarnessSurface } from "./harnessCapabilities";

import { CheckIcon, SearchIcon, StarIcon, ZapIcon } from "./chatIcons";
import { AccessMenu } from "./AccessMenu";
import { reasoningEffortSupported, type ChatAccess, type ProviderRuntimeConfig } from "./chatModel";
import { usePopover } from "./usePopover";

const MAX_COMPARE_PICKS = 6;
const PICKER_GAP = 8;
const PICKER_VIEWPORT_MARGIN = 12;
const PICKER_MAX_HEIGHT = 520;

interface PickerPosition {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface PickerComparePick extends PickDraft {
  /** A comparação existente não recebe credenciais de conta ou pool por escolha. */
  account: string | null;
}

/** O agente tem esforço que vira flag? (o controle some nos outros) */
export const hasEffort = reasoningEffortSupported;

export interface AgentModelValue {
  agentId: string | null;
  model: string | null;
  effort: string | null;
  /** O valor do seletor de conta: id, `pool:<nome>` ou `null` (a conta principal). */
  account: string | null;
}

/**
 * O primeiro roster da sessão (a sonda das TUIs é a parte cara, e o backend a guarda): só evita pedir de
 * novo a cada montagem. NÃO vale como lista de contas: elas nascem e morrem fora da tela (CLI, outra
 * janela, o login na TUI), então o seletor pede de novo toda vez que abre (`useRoster`).
 */
let rosterRequest: Promise<Roster> | null = null;
function loadRoster(): Promise<Roster> {
  rosterRequest ??= getRoster(false).catch((e) => {
    rosterRequest = null;
    throw e;
  });
  return rosterRequest;
}

/**
 * O roster do seletor. `open` = o menu está aberto: aí ele é pedido de novo (o backend remonta as contas
 * na hora e só reaproveita a sonda dos modelos, então é barato) e o resultado vira o novo guardado.
 * `update` troca o roster quando outra fonte traz um mais novo (a sonda do OpenCode).
 */
function useRoster(enabled: boolean, open = false): { roster: Roster | null; update: (next: Roster) => void } {
  const [roster, setRoster] = useState<Roster | null>(null);
  useEffect(() => {
    if (!enabled || roster) return;
    loadRoster().then(setRoster).catch(() => undefined);
  }, [enabled, roster]);
  useEffect(() => {
    if (!enabled || !open) return;
    let alive = true;
    getRoster(false)
      .then((next) => {
        rosterRequest = Promise.resolve(next);
        if (alive) setRoster(next);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [enabled, open]);
  const update = (next: Roster) => {
    rosterRequest = Promise.resolve(next);
    setRoster(next);
  };
  return { roster, update };
}

function catalogOf(roster: Roster | null, agentId: string | null, account: string | null): RosterModel[] {
  const agent = roster?.agents.find((a) => a.agentId === agentId);
  const pool = account?.startsWith("pool:") ?? false;
  return modelsForAccount(agent, pool ? null : account, pool);
}

function providerCatalogOf(config: ProviderRuntimeConfig | null | undefined): RosterModel[] {
  return (config?.model?.options ?? []).map(({ value, label }) => ({
    id: value, label, toolcall: null, local: false, costIn: null, costOut: null, context: null,
    source: "ACP", availability: "available", reasoningLevels: null, defaultReasoning: null, unavailable: null,
  }));
}

function pickerCatalogOf(roster: Roster | null, agentId: string | null, account: string | null, currentAgentId: string | null, providerConfig?: ProviderRuntimeConfig | null): RosterModel[] {
  if (agentId?.startsWith("local-acp-")) return agentId === currentAgentId ? providerCatalogOf(providerConfig) : [];
  return catalogOf(roster, agentId, account);
}

/**
 * Os níveis que o seletor oferece para o modelo. No Claude vêm da linha do próprio modelo, o mesmo critério que o
 * backend usa para aceitar o esforço: um modelo sem níveis não oferece esforço. O modelo padrão (sem linha) usa a lista padrão.
 */
function effortChoices(agentId: string | null, model: string | null, catalog: RosterModel[]): string[] {
  if (agentId === "claude-code") {
    const effectiveModel = effectiveModelForEffort(model, catalog);
    return effectiveModel ? claudeEffortLevels(effectiveModel, catalog) ?? [] : [];
  }
  const supported = reasoningOptions(model, catalog);
  return supported.length > 0 ? supported : DEFAULT_EFFORTS;
}

function effortsOf(agentId: string, model: string | null, catalog: RosterModel[], currentAgentId: string | null, providerConfig?: ProviderRuntimeConfig | null): string[] {
  if (agentId.startsWith("local-acp-")) {
    return agentId === currentAgentId ? (providerConfig?.effort?.options ?? []).map((option) => option.value) : [];
  }
  if (!hasEffort(agentId)) return [];
  return effortChoices(agentId, model, catalog);
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
 * Seletor no estilo T3 Code: trilho de agentes/favoritos, busca e catálogo no centro, ajuste de
 * raciocínio à direita e controles da ADE no rodapé. A área ampla mantém os nomes e opções legíveis.
 */
export function AgentModelPicker({ agents, value, onChange, shortcutHint, showAccount = true, accountSlot = null, permission, speed, onCompare, compareDisabled = false, disabled = false, placement = "above", providerConfig, harnessSurface = "tui" }: {
  agents: AgentInfo[];
  value: AgentModelValue;
  onChange: (next: AgentModelValue) => void;
  shortcutHint?: string;
  /** Numa conversa aberta a conta não muda (a sessão mora na pasta da conta). */
  showAccount?: boolean;
  /**
   * A conta de uma conversa aberta, no rodapé do mesmo popover (no lugar do seletor de conta da conversa nova): a
   * troca tem regras próprias (só entre turnos, com confirmação), por isso vem pronta de quem chama. Antes era um
   * seletor solto no composer, entre o modelo e o esforço.
   */
  accountSlot?: React.ReactNode;
  /** O acesso da conversa, agrupado no mesmo painel de agente/modelo. */
  permission?: { value: ChatAccess; modes: ChatAccess[]; onChange?: (next: ChatAccess) => void };
  /** Modo Fast. Só aparece quando a matriz e o catálogo confirmam suporte. */
  speed?: { fast: boolean; onChange: (fast: boolean) => void };
  /** Compara o texto atual com as escolhas feitas por Shift-clique. Só disponível ao criar conversa. */
  onCompare?: (picks: PickDraft[]) => void;
  /** Desliga comparação enquanto há citações/anexos ou escolhas com conta específica. */
  compareDisabled?: boolean;
  disabled?: boolean;
  /** Para onde o popover abre: em cima (o composer, no pé da tela) ou embaixo (uma linha das Configurações). */
  placement?: "above" | "below";
  /** Configuração anunciada pela sessão ACP do agente desta conversa. */
  providerConfig?: ProviderRuntimeConfig | null;
  /** Superfície em que a seleção vai iniciar ou trocar o agente. */
  harnessSurface?: HarnessSurface;
}) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const [popoverPosition, setPopoverPosition] = useState<PickerPosition | null>(null);
  const { roster, update: updateRoster } = useRoster(true, open);
  const [tab, setTab] = useState<string | "fav">(value.agentId ?? agents[0]?.id ?? "fav");
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>(loadFavorites);
  const [comparePicks, setComparePicks] = useState<PickerComparePick[]>([]);
  const agent = agents.find((a) => a.id === value.agentId) ?? agents[0] ?? null;
  const tabAgent = tab === "fav" ? agent : agents.find((a) => a.id === tab) ?? agent;
  useHarnessCapability(harnessSurface, matrixProviderForAgent(tabAgent?.id), "start");
  const fastCapability = useHarnessCapability(harnessSurface, matrixProviderForAgent(agent?.id), "fast_mode");
  const pools = usePools(tabAgent?.id ?? null);
  const current = pickerCatalogOf(roster, agent?.id ?? null, value.account, value.agentId, providerConfig);
  // O modelo salvo pode ser um alias (`opus`): a tela mostra a linha que ele resolve, com o nome e a versão dela.
  const selectedModel = findModel(current, value.model)
    ?? (value.model === null ? findModel(current, "opus") : undefined)
    ?? null;
  const modelLabel = value.model ? selectedModel?.label || value.model : t("chat.model.default");
  const efforts = agent ? effortsOf(agent.id, value.model, current, value.agentId, providerConfig) : [];
  const showReasoning = (!!permission || !!speed) && efforts.length > 0;
  const showFast = !!speed && fastCapability.support === "supported" && selectedModel?.fastSupported === true;
  const hasFooter = !!permission || !!speed || !!accountSlot || showAccount;

  useEffect(() => {
    if (speed?.fast && selectedModel?.fastSupported === false) speed.onChange(false);
  }, [selectedModel?.fastSupported, speed?.fast, speed?.onChange]);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverPosition(null);
      return;
    }
    const trigger = ref.current?.querySelector<HTMLButtonElement>("[data-chat-agent-model-picker]");
    if (!trigger) return;

    const measure = () => {
      const rect = trigger.getBoundingClientRect();
      // `getBoundingClientRect()` e `position: fixed` usam o viewport de layout do WebView.
      // Somar `visualViewport.offsetTop/Left` aqui deslocava o menu em janelas com zoom/escala
      // nativa, fazendo o topo ficar fora da área visível mesmo quando havia espaço disponível.
      const viewportLeft = 0;
      const viewportTop = 0;
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const marginX = Math.min(PICKER_VIEWPORT_MARGIN, viewportWidth / 2);
      const marginY = Math.min(PICKER_VIEWPORT_MARGIN, viewportHeight / 2);
      const viewportRight = viewportWidth;
      const viewportBottom = viewportHeight;
      const availableAbove = Math.max(0, rect.top - viewportTop - marginY - PICKER_GAP);
      const availableBelow = Math.max(0, viewportBottom - rect.bottom - marginY - PICKER_GAP);
      const preferAbove = placement === "above";
      const preferredSpace = preferAbove ? availableAbove : availableBelow;
      const alternateSpace = preferAbove ? availableBelow : availableAbove;
      const preferredFits = preferredSpace >= PICKER_MAX_HEIGHT;
      const alternateFits = alternateSpace >= PICKER_MAX_HEIGHT;
      const canAnchorAtFullHeight = preferredFits || alternateFits;
      const openAbove = preferredFits ? preferAbove
        : alternateFits ? !preferAbove
          : availableAbove >= availableBelow;
      const available = openAbove ? availableAbove : availableBelow;
      const width = Math.min(showReasoning ? 740 : 480, Math.max(0, viewportWidth - marginX * 2));
      const left = Math.max(viewportLeft + marginX,
        Math.min(rect.right - width, viewportRight - width - marginX));
      const viewportHeightLimit = Math.max(0, viewportHeight - marginY * 2);
      let height = Math.max(0, Math.min(PICKER_MAX_HEIGHT,
        canAnchorAtFullHeight ? available : viewportHeightLimit));
      let preferredTop = openAbove
        ? rect.top - height - PICKER_GAP
        : rect.bottom + PICKER_GAP;
      // Se nenhum lado comporta o painel inteiro, centralize a altura máxima disponível.
      // Reduzir à sobra parcial acima do composer deixa o cabeçalho e o rodapé espremidos
      // contra a borda da janela em telas menores ou com escala ampliada.
      if (!canAnchorAtFullHeight) {
        preferredTop = viewportTop + marginY + (viewportHeightLimit - height) / 2;
      }
      // Protege contra arredondamento de pixels e diferenças de escala entre a janela nativa
      // e o WebView: nenhuma borda do painel pode sair do viewport calculado.
      const top = Math.max(viewportTop + marginY,
        Math.min(preferredTop, viewportBottom - marginY - height));
      setPopoverPosition({ top, left, width, height });
    };

    measure();
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    const observer = new ResizeObserver(measure);
    observer.observe(trigger);
    return () => {
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
      observer.disconnect();
    };
  }, [open, placement, ref, showReasoning, hasFooter]);

  // Os provedores do OpenCode mudam fora do app (`opencode auth login`): ao abrir, sonda de novo.
  useEffect(() => {
    if (!open || tabAgent?.id !== "opencode") return;
    let alive = true;
    refreshRosterModels("opencode", value.agentId === "opencode" && value.account && !value.account.startsWith("pool:") ? value.account : null)
      .then((next) => { if (alive) updateRoster(next); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [open, tabAgent?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- só ao abrir ou trocar de aba

  useEffect(() => { if (open && agent) setTab(agent.id); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- só ao abrir

  useEffect(() => {
    if (!open) return;
    const onQuickSelect = (event: Event) => {
      const quick = event as CustomEvent<{ kind?: string; index?: number }>;
      if (quick.detail?.kind !== "model") return;
      const index = quick.detail.index;
      if (!Number.isInteger(index) || index! < 1 || index! > 9) return;
      const option = ref.current?.querySelectorAll<HTMLButtonElement>('[role="listbox"] [role="option"]')[index! - 1];
      if (!option) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      option.click();
    };
    window.addEventListener("ade:chat-quick-select", onQuickSelect);
    return () => window.removeEventListener("ade:chat-quick-select", onQuickSelect);
  }, [open, ref]);

  const rows: Row[] = useMemo(() => {
    const ofAgent = (a: AgentInfo): Row[] => [
      { agent: a, model: null, label: t("chat.model.default") },
      ...pickerCatalogOf(roster, a.id, a.id === value.agentId ? value.account : null, value.agentId, providerConfig).map((m) => ({ agent: a, model: m.id, label: m.label || m.id })),
    ];
    const base = tab === "fav"
      ? agents.flatMap(ofAgent).filter((r) => r.model && favorites.includes(favKey(r.agent.id, r.model)))
      : tabAgent ? ofAgent(tabAgent) : [];
    const q = query.trim().toLowerCase();
    return q ? base.filter((r) => `${r.label} ${r.model ?? ""}`.toLowerCase().includes(q)) : base;
  }, [agents, roster, tab, tabAgent, favorites, query, value.agentId, value.account, providerConfig, t]);

  const toggleFav = (r: Row) => {
    if (!r.model) return;
    const key = favKey(r.agent.id, r.model);
    const next = favorites.includes(key) ? favorites.filter((f) => f !== key) : [...favorites, key];
    setFavorites(next);
    saveFavorites(next);
  };

  const toggleComparePick = (r: Row) => {
    const account = r.agent.id === value.agentId ? value.account : null;
    const catalog = pickerCatalogOf(roster, r.agent.id, account, value.agentId, providerConfig);
    const nextEfforts = effortsOf(r.agent.id, r.model, catalog, value.agentId, providerConfig);
    const effort = r.agent.id === agent?.id && (value.effort === null || nextEfforts.includes(value.effort)) ? value.effort : null;
    const selected = findModel(catalog, r.model)
      ?? (r.model === null ? findModel(catalog, "opus") : undefined);
    const fastCapabilityAvailable = readHarnessCapability(harnessSurface, matrixProviderForAgent(r.agent.id) ?? "", "fast_mode").support === "supported";
    const pick: PickerComparePick = {
      agentId: r.agent.id,
      model: r.model,
      effort,
      fast: fastCapabilityAvailable && speed?.fast === true && selected?.fastSupported === true,
      account,
    };
    setComparePicks((current) => {
      const index = current.findIndex((item) => item.agentId === pick.agentId && item.model === pick.model && item.account === pick.account);
      if (index >= 0) return current.filter((_, i) => i !== index);
      if (current.length >= MAX_COMPARE_PICKS) return current;
      return [...current, pick];
    });
  };

  const onAgentTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const focused = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="tab"]');
    const currentValue = focused?.dataset.tabValue ?? tab;
    const index = buttons.findIndex((button) => button.dataset.tabValue === currentValue);
    if (index < 0 || buttons.length === 0) return;
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : delta ? (index + delta + buttons.length) % buttons.length : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = buttons[nextIndex];
    setTab(next.dataset.tabValue ?? "fav");
    next.focus();
  };

  const onModelListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    if (options.length === 0) return;
    const focused = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="option"]');
    const index = focused ? options.indexOf(focused) : -1;
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? options.length - 1
        : event.key === "ArrowDown" ? (index + 1 + options.length) % options.length
          : event.key === "ArrowUp" ? (index < 0 ? options.length - 1 : (index - 1 + options.length) % options.length)
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = options[nextIndex];
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  };

  if (!agent) return <span className="px-2 text-chat-note text-gray-400 dark:text-white/40">{t("chat.agent.none")}</span>;
  const Icon = agentIcon(agent.id, agent.command);

  return (
    <div ref={ref} className="relative min-w-0 max-w-full">
      <button data-chat-agent-model-picker="" type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => !disabled && setOpen(!open)} title={shortcutHint} disabled={disabled}
        className={`flex max-w-full items-center gap-1.5 h-7 px-2 rounded-lg whitespace-nowrap text-chat-ui font-medium text-gray-900/85 dark:text-white/85
          hover:bg-gray-100 dark:hover:bg-white/[0.07] ${open ? "bg-gray-100 dark:bg-white/[0.07]" : ""}`}>
        <Icon className="w-4 h-4 shrink-0" />
        <span className="min-w-0 truncate max-w-52">{modelLabel}</span>
      </button>

      {open && popoverPosition && createPortal(
        <div role="dialog" aria-label={t("chat.picker.title")} onMouseDown={(event) => event.stopPropagation()}
          style={{ position: "fixed", top: popoverPosition.top, left: popoverPosition.left, width: popoverPosition.width, height: popoverPosition.height,
            maxHeight: `calc(100vh - ${PICKER_VIEWPORT_MARGIN * 2}px)`, boxSizing: "border-box" }}
          className={`z-50 flex flex-col rounded-2xl ${ref.current?.closest(".cc-chat-type") ? "cc-chat-type" : ""}
            overflow-hidden bg-white/[0.92] dark:bg-surface-raised/[0.92] backdrop-blur-xl
            shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_20px_52px_-20px_rgba(0,0,0,0.55)]`}>
          <div className={`flex flex-1 min-h-0 ${hasFooter ? "rounded-t-lg" : "rounded-lg"} overflow-hidden`}>
          <div role="tablist" aria-label={t("chat.picker.agents")} onKeyDown={onAgentTabKeyDown}
            className="w-14 shrink-0 flex flex-col items-center gap-1.5 p-2 cc-scroll-hidden bg-gray-50/60 dark:bg-white/[0.01]">
            <RailButton value="fav" tabIndex={tab === "fav" ? 0 : -1} label={t("chat.picker.favorites")} on={tab === "fav"} onClick={() => setTab("fav")}>
              <StarIcon filled className="w-5 h-5 text-amber-500" />
            </RailButton>
            <span aria-hidden="true" className="w-5 h-px my-0.5 bg-gray-200 dark:bg-white/10" />
            {agents.map((a) => {
              const AIcon = agentIcon(a.id, a.command);
              return (
                <RailButton key={a.id} value={a.id} tabIndex={tab === a.id ? 0 : -1} label={a.label} on={tab === a.id} onClick={() => setTab(a.id)}>
                  <AIcon className="w-6 h-6" />
                </RailButton>
              );
            })}
          </div>

          <div className="flex-1 min-w-0 flex flex-col border-l border-gray-200 dark:border-white/[0.08] bg-gray-50/80 dark:bg-white/[0.01]">
            <label className="flex items-center gap-2 h-14 shrink-0 px-4 border-b border-gray-200 dark:border-white/[0.08] text-gray-500 dark:text-white/45">
              <SearchIcon className="w-3.5 h-3.5" />
              <span className="sr-only">{t("chat.picker.search")}</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("chat.picker.search")} autoFocus
                className="flex-1 min-w-0 bg-transparent outline-none text-[15px] text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-white/35" />
            </label>
            {showReasoning && (
              <div className="hidden max-[640px]:flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-white/[0.08]">
                <span className="text-chat-caption font-medium text-gray-500 dark:text-white/45">{t("chat.picker.effort")}</span>
                <PopupSelect aria-label={t("chat.picker.effort")} value={value.effort ?? ""}
                  onChange={(e) => onChange({ ...value, effort: e.target.value || null })} className="min-w-28 text-chat-ui">
                  <option value="">{t("chat.effort.default")}</option>
                  {efforts.map((effort) => <option key={effort} value={effort}>{t(`chat.effort.${effort}`, { defaultValue: effort })}</option>)}
                </PopupSelect>
                {value.effort === "ultracode" && <span className="basis-full text-[10px] text-amber-700 dark:text-amber-300">{t("chat.picker.ultracodeWarning")}</span>}
              </div>
            )}
            <div role="listbox" aria-label={t("chat.picker.models")} tabIndex={0} onKeyDown={onModelListKeyDown} className="flex-1 min-h-0 cc-scroll-hidden p-2">
              {onCompare && (
                <div className="mb-1 flex min-h-9 items-center gap-2 rounded-lg px-3 text-chat-caption text-gray-500 dark:text-white/45">
                  <span className="min-w-0 flex-1 truncate">{comparePicks.length > 0
                    ? t("chat.picker.compareSelection", { count: comparePicks.length, max: MAX_COMPARE_PICKS })
                    : t("chat.picker.compareHint")}</span>
                  {comparePicks.length > 0 && <button type="button" onClick={() => setComparePicks([])}
                    className="shrink-0 rounded px-1.5 py-1 hover:bg-gray-200/70 dark:hover:bg-white/10">{t("chat.picker.clearSelection")}</button>}
                  {comparePicks.length >= 2 && <button type="button" disabled={compareDisabled || comparePicks.some((pick) => pick.account !== null)}
                    title={compareDisabled || comparePicks.some((pick) => pick.account !== null) ? t("chat.picker.compareContextUnsupported") : undefined}
                    onClick={() => { onCompare(comparePicks.map(({ account: _account, ...pick }) => pick)); setOpen(false); setComparePicks([]); }}
                    className="shrink-0 rounded-md bg-accent-600 px-2.5 py-1.5 font-medium text-white hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-45">
                    {t("chat.picker.compareModels", { count: comparePicks.length })}
                  </button>}
                </div>
              )}
              {rows.map((r, i) => {
                const group = r.agent.id === "opencode" && r.model?.includes("/") ? r.model.split("/")[0] : null;
                const prevGroup = i > 0 && rows[i - 1].agent.id === "opencode" ? rows[i - 1].model?.split("/")[0] : undefined;
                const showGroup = !!group && (i === 0 || prevGroup !== group || !rows[i - 1].model?.includes("/"));
                const RIcon = agentIcon(r.agent.id, r.agent.command);
                const selected = r.agent.id === agent.id && r.model === (selectedModel?.id ?? value.model);
                const startAvailability = readHarnessCapability(harnessSurface, matrixProviderForAgent(r.agent.id) ?? "", "start");
                const fav = !!r.model && favorites.includes(favKey(r.agent.id, r.model));
                const compareIndex = comparePicks.findIndex((pick) => pick.agentId === r.agent.id && pick.model === r.model);
                return (
                  <Fragment key={`${r.agent.id}:${r.model ?? ""}`}>
                  {showGroup && <div className="px-3 pt-3 pb-1.5 text-chat-caption font-medium uppercase tracking-wide text-gray-500 dark:text-white/45">{group}</div>}
                  <div
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg ${selected ? "bg-gray-200/60 dark:bg-white/10" : "hover:bg-gray-200/40 dark:hover:bg-white/[0.06]"}`}>
                    <button type="button" role="option" aria-selected={selected} aria-disabled={!startAvailability.available || undefined} disabled={!startAvailability.available} title={!startAvailability.available ? startAvailability.reason ?? undefined : undefined} tabIndex={-1}
                      onClick={(event) => {
                        if (onCompare && event.shiftKey) {
                          toggleComparePick(r);
                          return;
                        }
                        const sameAgent = r.agent.id === value.agentId;
                        const account = sameAgent ? value.account : null;
                        const providerModelChanged = sameAgent && r.agent.id.startsWith("local-acp-") && value.model !== r.model;
                        const nextCatalog = pickerCatalogOf(roster, r.agent.id, account, value.agentId, providerConfig);
                        const nextEfforts = effortsOf(r.agent.id, r.model, nextCatalog, value.agentId, providerConfig);
                        const effort = !providerModelChanged && sameAgent && (value.effort === null || nextEfforts.includes(value.effort)) ? value.effort : null;
                        onChange({ agentId: r.agent.id, model: r.model, effort, account });
                        const nextModel = findModel(nextCatalog, r.model)
                          ?? (r.model === null ? findModel(nextCatalog, "opus") : undefined);
                        const fastAvailable = readHarnessCapability(harnessSurface, matrixProviderForAgent(r.agent.id) ?? "", "fast_mode").support === "supported";
                        // Ao escolher outro agente numa conversa aberta, a troca ainda vai passar
                        // por confirmação; não altere/reinicie o agente atual antes dela.
                        if (sameAgent && speed?.fast && (!fastAvailable || nextModel?.fastSupported !== true)) {
                          speed.onChange(false);
                        }
                        setOpen(false);
                      }}
                      className="flex-1 min-w-0 flex flex-col items-start text-left disabled:cursor-not-allowed disabled:opacity-45">
                      <span className="w-full truncate text-[15px] leading-5 text-gray-900 dark:text-white">{r.label}</span>
                      <span className="flex items-center gap-1.5 text-chat-caption text-gray-500 dark:text-white/45">
                        <RIcon className="w-3 h-3" />{r.agent.label}
                      </span>
                    </button>
                    {compareIndex >= 0 && <span aria-label={t("chat.picker.compareSelected", { count: compareIndex + 1 })}
                      className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent-600 px-1 text-[10px] font-semibold text-white">{compareIndex + 1}</span>}
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
              {tabAgent?.id.startsWith("local-acp-") && tabAgent.id === value.agentId && !providerConfig && !query.trim() && (
                <p className="px-2 py-3 text-chat-note text-gray-500 dark:text-white/45">{t("chat.picker.providerOptionsPending")}</p>
              )}
              {tabAgent?.id.startsWith("local-acp-") && tabAgent.id === value.agentId && providerConfig && !(providerConfig.model?.options.length) && !query.trim() && (
                <p className="px-2 py-3 text-chat-note text-gray-500 dark:text-white/45">{t("chat.picker.providerModelsUnavailable")}</p>
              )}
              {tab === "cursor" && (
                // O Cursor não tem flag de esforço: cada variante (`…-low`, `…-high`) é um modelo da própria lista.
                <p className="px-2 py-2 text-chat-caption text-gray-500 dark:text-white/45">{t("chat.picker.cursorEffort")}</p>
              )}
              {!roster && tab !== "fav" && <p className="px-2 py-3 text-chat-note text-gray-400 dark:text-white/40">{t("chat.picker.loading")}</p>}
            </div>
          </div>
          {showReasoning && (
            <aside aria-label={t("chat.picker.effort")} className="hidden min-[641px]:flex w-64 shrink-0 flex-col border-l border-gray-200 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.015]">
              <div className="h-14 shrink-0 px-4 flex items-center justify-between gap-2 border-b border-gray-200 dark:border-white/[0.08]">
                <span className="text-chat-ui font-medium text-gray-500 dark:text-white/45">{t("chat.picker.effort")}</span>
                <span className="max-w-32 truncate text-chat-caption text-gray-400 dark:text-white/35" title={modelLabel}>{modelLabel}</span>
              </div>
              <div role="radiogroup" aria-label={t("chat.picker.effort")} className="flex-1 min-h-0 cc-scroll-hidden p-2">
                {[null, ...efforts].map((effort) => (
                  <button key={effort ?? "default"} type="button" role="radio" aria-checked={(value.effort ?? null) === effort}
                    onClick={() => onChange({ ...value, effort })}
                    className="w-full min-h-11 px-3 rounded-lg flex items-center gap-2 text-left text-[15px] text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-white/[0.07]">
                    <span className="flex-1 flex flex-col">
                      <span>{effort ? t(`chat.effort.${effort}`, { defaultValue: effort }) : t("chat.effort.default")}</span>
                      {effort === "ultracode" && <span className="text-[11px] leading-4 text-gray-500 dark:text-white/45">{t("models.effort.ultracodeHint")}</span>}
                    </span>
                    {(value.effort ?? null) === effort && <CheckIcon className="w-3.5 h-3.5 shrink-0" />}
                  </button>
                ))}
              </div>
              {value.effort === "ultracode" && <p role="note" className="px-3 pb-3 text-[11px] leading-4 text-amber-700 dark:text-amber-300">{t("chat.picker.ultracodeWarning")}</p>}
            </aside>
          )}
          </div>
          {hasFooter && (
            <div className="min-h-14 shrink-0 flex items-center gap-2 px-3 border-t border-gray-200 dark:border-white/[0.08] rounded-b-2xl text-chat-caption text-gray-500 dark:text-white/45">
              {showFast && speed && (
                <div role="group" aria-label={t("chat.picker.speedMode")} className="flex items-center gap-0.5 p-1 rounded-lg bg-gray-100 dark:bg-white/[0.07]">
                  <button type="button" aria-pressed={!speed.fast} onClick={() => speed.onChange(false)}
                    className={`h-8 px-3 rounded-md text-chat-ui font-medium ${!speed.fast ? "bg-white dark:bg-surface-overlay text-gray-900 dark:text-white shadow-sm" : "text-gray-500 dark:text-white/45 hover:text-gray-800 dark:hover:text-white/80"}`}>
                    {t("chat.picker.standard")}
                  </button>
                  <button type="button" aria-pressed={speed.fast} onClick={() => speed.onChange(true)}
                    className={`h-8 px-3 rounded-md text-chat-ui font-medium ${speed.fast ? "bg-white dark:bg-surface-overlay text-gray-900 dark:text-white shadow-sm" : "text-gray-500 dark:text-white/45 hover:text-gray-800 dark:hover:text-white/80"}`}>
                    <span className="inline-flex items-center gap-1"><ZapIcon className="w-3 h-3" />{t("chat.picker.fast")}</span>
                  </button>
                </div>
              )}
              <span className="flex-1" />
              {permission && <AccessMenu value={permission.value} available={permission.modes} onChange={permission.onChange} />}
              {!showAccount && accountSlot}
              {showAccount && <>
                <span>{t("chat.picker.account")}</span>
                {tabAgent && (
                  <PopupSelect value={tabAgent.id === value.agentId ? value.account ?? "" : ""} aria-label={t("chat.picker.account")}
                    onChange={(e) => onChange({ agentId: tabAgent.id, model: tabAgent.id === value.agentId ? value.model : null, effort: tabAgent.id === value.agentId ? value.effort : null, account: e.target.value || null })}
                    className="max-w-36 text-chat-caption">
                    <option value="">{t("accounts.system")}</option>
                    {(roster?.agents.find((a) => a.agentId === tabAgent.id)?.accounts ?? []).filter((a) => a.accountId !== null).map((a) => (
                      <option key={a.accountId!} value={a.accountId!}>{a.label ?? a.name}</option>
                    ))}
                    {pools.map((p) => <option key={p.id} value={poolValue(p.name)}>{t("chat.picker.pool", { name: p.name })}</option>)}
                  </PopupSelect>
                )}
              </>}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

function RailButton({ value, tabIndex, label, on, onClick, children }: { value: string; tabIndex: number; label: string; on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="tab" data-tab-value={value} tabIndex={tabIndex} aria-selected={on} aria-label={label} title={label} onClick={onClick}
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
  const { roster } = useRoster(reasoningEffortSupported(agentId), open);
  if (!reasoningEffortSupported(agentId)) return null;
  const efforts = effortChoices(agentId, model, catalogOf(roster, agentId, account));
  const label = (e: string) => t(`chat.effort.${e}`, { defaultValue: e });
  return (
    <div ref={ref} className="relative -ml-1.5">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => !disabled && setOpen(!open)} disabled={disabled}
        className={`h-7 px-1.5 rounded-lg whitespace-nowrap text-chat-ui font-medium text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/[0.07] ${open ? "bg-gray-100 dark:bg-white/[0.07]" : ""}`}>
        {value ? <EffortLevel value={value} efforts={efforts} label={label(value)} /> : t("chat.effort.default")}
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
        </div>
      )}
    </div>
  );
}
