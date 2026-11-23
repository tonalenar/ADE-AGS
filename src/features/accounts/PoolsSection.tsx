import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";

import { agentIcon } from "@/features/agents/agentIcons";
import { useUsageStore } from "@/features/canvas/usageStore";
import { SettingsGroup } from "@/features/settings/SettingsSection";
import { AlertaToast } from "@/shared/ui/alerts";
import { AppDialog } from "@/shared/ui/AppDialog";

import { accountBadgeStyle, accountDisplayLabel, accountInitials } from "./accountIdentity";
import { CHAT_POOL_MODES, loadChatPoolMode, saveChatPoolMode, type ChatPoolMode } from "./chatPool";
import { isPoolEmpty } from "./poolRef";
import {
  STRATEGIES,
  poolPreviewPicks,
  poolRemove,
  poolSaveNew,
  poolSetPaused,
  poolUpdate,
  usePools,
  type Pool,
  type PoolPickPreview,
  type PoolStrategy,
} from "./pools";
import { useAccountsStore } from "./store";
import type { AccountCapableAgent, AgentAccount } from "./types";

function usagePercentOf(
  account: AgentAccount | undefined,
  claude: ReturnType<typeof useUsageStore.getState>["claude"],
  codex: ReturnType<typeof useUsageStore.getState>["codex"],
  antigravity: ReturnType<typeof useUsageStore.getState>["antigravity"],
  agy: ReturnType<typeof useUsageStore.getState>["agy"],
): number | null {
  if (!account || !account.loggedIn) return null;
  if (account.agentId === "claude-code") {
    const live = claude[account.id];
    if (!live?.available) return null;
    return live.week?.percent ?? live.session?.percent ?? null;
  }
  if (account.agentId === "codex") {
    const q = codex[account.id]?.usage?.quota;
    if (!q) return null;
    if (q.sevenDay) return Math.round(q.sevenDay.utilization * 100);
    if (q.fiveHour) return Math.round(q.fiveHour.utilization * 100);
    return null;
  }
  if (account.agentId === "antigravity") {
    const groups = account.id.startsWith("system:") ? agy.usage?.groups : antigravity[account.id]?.groups;
    const weekly = groups?.[0]?.windows.find((w) => w.kind === "weekly") ?? groups?.[0]?.windows[0];
    if (weekly) return Math.round(weekly.usedPct);
  }
  return null;
}

/** Menu ⋯ para cada pool. */
function PoolOverflowMenu({ label, paused, empty = false, poolName, onEdit, onCopy, onTogglePause, onDelete }: {
  label: string;
  paused: boolean;
  empty?: boolean;
  poolName: string;
  onEdit: () => void;
  onCopy: () => void;
  onTogglePause: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-7 w-7 items-center justify-center rounded-md text-[16px] leading-none transition-colors
          ${open
            ? "bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white"
            : "text-gray-400 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white"}`}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+4px)] z-30 w-60 rounded-xl border border-gray-200 dark:border-white/[0.1] bg-white dark:bg-surface-raised p-1.5 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onEdit(); }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
          >
            <span aria-hidden="true" className="w-4 text-center opacity-75">✎</span>
            <span>{t("btn.edit")}</span>
          </button>
          {!empty && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); onCopy(); }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
              >
                <span aria-hidden="true" className="w-4 text-center opacity-75">⧉</span>
                <span>
                  {t("accounts.pools.menu.copyPrefix")}{" "}
                  <code className="rounded bg-gray-100 dark:bg-white/10 px-1 py-px text-[11px]">pool:{poolName}</code>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); onTogglePause(); }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
              >
                <span aria-hidden="true" className="w-4 text-center opacity-75">{paused ? "▶" : "⏸"}</span>
                <span>{paused ? t("accounts.pools.menu.resume") : t("accounts.pools.menu.pause")}</span>
              </button>
            </>
          )}
          <hr className="my-1 border-0 border-t border-gray-200 dark:border-white/[0.08]" />
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onDelete(); }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
          >
            <span aria-hidden="true" className="w-4 text-center opacity-75">🗑</span>
            <span>{t("btn.delete")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Diálogo Novo / Editar Pool: nome, agente, membros com ordem (▲/▼) e regra de escolha. */
export function PoolEditorDialog({ editing, eligibleAgents, accounts, systemAccounts, onClose, onSaved, onDelete }: {
  editing: Pool | null;
  eligibleAgents: AccountCapableAgent[];
  accounts: AgentAccount[];
  systemAccounts: AgentAccount[];
  onClose: () => void;
  onSaved: () => void;
  onDelete?: (pool: Pool) => void;
}) {
  const { t } = useTranslation();
  const claude = useUsageStore((s) => s.claude);
  const codex = useUsageStore((s) => s.codex);
  const antigravity = useUsageStore((s) => s.antigravity);
  const agy = useUsageStore((s) => s.agy);

  const [agentId, setAgentId] = useState(editing?.agentId ?? eligibleAgents[0]?.agentId ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [members, setMembers] = useState<(string | null)[]>(editing?.members ? [...editing.members] : []);
  const [strategy, setStrategy] = useState<PoolStrategy>(editing?.strategy ?? "least_used");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const allForAgent = useMemo(() => {
    const sys = systemAccounts.find((a) => a.agentId === agentId);
    const extras = accounts.filter((a) => a.agentId === agentId);
    const list: { memberId: string | null; account?: AgentAccount; label: string; isMain: boolean }[] = [
      {
        memberId: null,
        account: sys,
        label: sys ? accountDisplayLabel(sys, t("accounts.principalName")) : t("accounts.principalName"),
        isMain: true,
      },
      ...extras.map((a) => ({
        memberId: a.id,
        account: a,
        label: accountDisplayLabel(a, t("accounts.principalName")),
        isMain: false,
      })),
    ];
    return list;
  }, [agentId, accounts, systemAccounts, t]);

  // Membros selecionados primeiro (na ordem), depois os não selecionados.
  const orderedOptions = useMemo(() => {
    const selected = members
      .map((id) => allForAgent.find((o) => o.memberId === id))
      .filter((o): o is NonNullable<typeof o> => Boolean(o));
    const rest = allForAgent.filter((o) => !members.includes(o.memberId));
    return [...selected, ...rest];
  }, [allForAgent, members]);

  const toggleMember = (id: string | null) => {
    setError("");
    setMembers((cur) => (cur.includes(id) ? cur.filter((m) => m !== id) : [...cur, id]));
  };

  const moveMember = (id: string | null, delta: -1 | 1) => {
    setMembers((cur) => {
      const idx = cur.indexOf(id);
      const nextIdx = idx + delta;
      if (idx < 0 || nextIdx < 0 || nextIdx >= cur.length) return cur;
      const copy = [...cur];
      copy.splice(idx, 1);
      copy.splice(nextIdx, 0, id);
      return copy;
    });
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || members.length < 2) {
      setError(t("accounts.pools.editor.validation"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (editing) {
        await poolUpdate(editing.id, trimmed, members, strategy);
        AlertaToast(t("accounts.pools.title"), t("accounts.pools.saved"), "success", 3000);
      } else {
        await poolSaveNew(trimmed, agentId, members, strategy, true);
        AlertaToast(t("accounts.pools.title"), t("accounts.pools.created", { name: trimmed }), "success", 3000);
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      title={editing ? t("accounts.pools.editTitle") : t("accounts.pools.add")}
      onClose={onClose}
      size="md"
      closeOnBackdrop={!busy}
      closeOnEsc={!busy}
      footer={
        <div className="flex w-full items-center gap-2">
          {editing && onDelete && (
            <Button
              variant="danger"
              size="sm"
              className="mr-auto"
              disabled={busy}
              onClick={() => onDelete(editing)}
            >
              {t("accounts.pools.delete")}
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>{t("btn.save")}</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3.5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <Input
              label={t("settings.tuis.name")}
              value={name}
              maxLength={30}
              onChange={(e) => { setName(e.target.value); setError(""); }}
              placeholder={t("accounts.pools.namePlaceholder")}
              variant="outline"
              autoFocus
            />
            <span className="text-[11.5px] text-gray-400 dark:text-white/40">
              {t("accounts.pools.useAs")}{" "}
              <code className="rounded bg-gray-100 dark:bg-white/10 px-1 py-px text-[11px]">
                pool:{name.trim() || t("accounts.pools.nameSample")}
              </code>
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-gray-700 dark:text-gray-200">{t("accounts.pools.agent")}</span>
            <div
              role="radiogroup"
              aria-label={t("accounts.pools.agent")}
              className={`flex flex-wrap gap-1 rounded-lg bg-gray-100 dark:bg-white/[0.06] p-0.5 ${editing ? "opacity-60" : ""}`}
            >
              {eligibleAgents.map((c) => {
                const active = c.agentId === agentId;
                return (
                  <button
                    key={c.agentId}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={Boolean(editing)}
                    onClick={() => { setAgentId(c.agentId); setMembers([]); setError(""); }}
                    className={`flex-1 h-7 px-2 rounded-md text-[12px] font-medium transition-colors whitespace-nowrap
                      ${active
                        ? "bg-white dark:bg-white/[0.12] text-gray-900 dark:text-white shadow-xs"
                        : "text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white"}`}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-gray-700 dark:text-gray-200">
            {t("accounts.pools.editor.membersTitle")}{" "}
            <span className="font-normal text-gray-400 dark:text-white/40">· {t("accounts.pools.editor.membersHint")}</span>
          </span>
          <div className="flex flex-col gap-1.5">
            {orderedOptions.map((opt) => {
              const idx = members.indexOf(opt.memberId);
              const on = idx >= 0;
              const style = accountBadgeStyle(opt.account?.accentColor);
              const pct = usagePercentOf(opt.account, claude, codex, antigravity, agy);
              const usageText = opt.account && !opt.account.loggedIn
                ? t("accounts.pools.noLogin")
                : pct !== null
                  ? t("accounts.pools.weekUsage", { percent: pct })
                  : "";

              return (
                <div
                  key={opt.memberId ?? "system"}
                  className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors
                    ${on
                      ? "border-gray-200 dark:border-white/[0.12] bg-white dark:bg-white/[0.04]"
                      : "border-gray-200/70 dark:border-white/[0.06] opacity-55 hover:opacity-80"}`}
                >
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleMember(opt.memberId)}
                    className="flex flex-1 min-w-0 items-center gap-2 text-left"
                  >
                    <span
                      aria-hidden="true"
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[11px]
                        ${on
                          ? "border-accent-500 bg-accent-500 text-white"
                          : "border-gray-300 dark:border-white/25"}`}
                    >
                      {on ? "✓" : ""}
                    </span>
                    <span className="w-4 shrink-0 text-center text-[11.5px] text-gray-400 dark:text-white/40 tabular-nums">
                      {on ? idx + 1 : ""}
                    </span>
                    <span
                      aria-hidden="true"
                      style={style}
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold
                        ${style ? "" : "bg-gray-200 text-gray-700 dark:bg-white/12 dark:text-white"}`}
                    >
                      {accountInitials(opt.label)}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-[12.5px] text-gray-900 dark:text-white">
                      {opt.label}
                      {opt.isMain && <span className="text-gray-400 dark:text-white/40"> · {t("chat.accounts.main").toLowerCase()}</span>}
                    </span>
                    {usageText && <span className="shrink-0 text-[11px] text-gray-400 dark:text-white/40 tabular-nums">{usageText}</span>}
                  </button>
                  {on && (
                    <span className="flex flex-col shrink-0">
                      <button
                        type="button"
                        aria-label={t("accounts.pools.editor.moveUp", { name: opt.label })}
                        disabled={idx === 0}
                        onClick={() => moveMember(opt.memberId, -1)}
                        className="px-1 text-[9px] leading-none text-gray-400 hover:text-gray-900 dark:hover:text-white disabled:opacity-30"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        aria-label={t("accounts.pools.editor.moveDown", { name: opt.label })}
                        disabled={idx === members.length - 1}
                        onClick={() => moveMember(opt.memberId, 1)}
                        className="px-1 text-[9px] leading-none text-gray-400 hover:text-gray-900 dark:hover:text-white disabled:opacity-30"
                      >
                        ▼
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-gray-700 dark:text-gray-200">{t("accounts.pools.editor.strategyTitle")}</span>
          <div role="radiogroup" aria-label={t("accounts.pools.editor.strategyTitle")} className="flex flex-col gap-1.5">
            {STRATEGIES.map((s) => {
              const active = strategy === s;
              return (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setStrategy(s)}
                  className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors
                    ${active
                      ? "border-accent-500 bg-accent-500/8 dark:bg-accent-500/12"
                      : "border-gray-200 dark:border-white/[0.08] hover:bg-gray-50 dark:hover:bg-white/[0.03]"}`}
                >
                  <span aria-hidden="true" className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${active ? "border-accent-500" : "border-gray-300 dark:border-white/25"}`}>
                    {active && <span className="h-2 w-2 rounded-full bg-accent-500" />}
                  </span>
                  <span className="flex flex-col gap-0.5">
                    <b className="text-[12.5px] font-semibold text-gray-900 dark:text-white">{t(`accounts.pools.strategy.${s}.full`)}</b>
                    <small className="text-[11.5px] text-gray-500 dark:text-white/50">{t(`accounts.pools.strategy.${s}.hint`)}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {error && <p role="alert" className="m-0 text-[12px] text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </AppDialog>
  );
}

/**
 * Nova aba Pools (Configurações → Provedores e contas → Pools):
 * - Cartão global unificado "Quando a cota de uma conta acabar" (Não trocar / Perguntar / Trocar sozinho);
 * - Lista de todos os pools com cadeia de contas, uso, "Agora escolheria X" (vindo de `routing::pick_in_pool`);
 * - Menu ⋯ com Editar, Copiar `pool:Nome`, Pausar/Retomar e Excluir.
 */
export function PoolsTabPage() {
  const { t } = useTranslation();
  const pools = usePools();
  const accounts = useAccountsStore((s) => s.accounts);
  const systemAccounts = useAccountsStore((s) => s.systemAccounts);
  const capable = useAccountsStore((s) => s.capable);
  const accountsLoaded = useAccountsStore((s) => s.loaded);
  const loadAccounts = useAccountsStore((s) => s.load);
  const claude = useUsageStore((s) => s.claude);
  const codex = useUsageStore((s) => s.codex);
  const antigravity = useUsageStore((s) => s.antigravity);
  const agy = useUsageStore((s) => s.agy);

  const [mode, setMode] = useState<ChatPoolMode>("ask");
  const [modeError, setModeError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, PoolPickPreview>>({});
  const [editorState, setEditorState] = useState<{ open: boolean; pool: Pool | null }>({ open: false, pool: null });
  const [deleting, setDeleting] = useState<Pool | null>(null);

  const refreshPreviews = useCallback(() => {
    poolPreviewPicks()
      .then((list) => setPreviews(Object.fromEntries(list.map((p) => [p.poolId, p]))))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!accountsLoaded) loadAccounts().catch(() => undefined);
    loadChatPoolMode().then(setMode).catch(() => setMode("ask"));
  }, [accountsLoaded, loadAccounts]);

  useEffect(() => {
    refreshPreviews();
  }, [pools, accounts, systemAccounts, refreshPreviews]);

  const changeMode = (next: ChatPoolMode) => {
    setModeError(null);
    saveChatPoolMode(next)
      .then(() => setMode(next))
      .catch((e) => setModeError(String(e)));
  };

  const eligibleAgents = useMemo(
    () => capable.filter((c) => [...systemAccounts, ...accounts].filter((a) => a.agentId === c.agentId).length >= 2),
    [capable, systemAccounts, accounts],
  );

  const agentsWithoutPool = useMemo(
    () => capable.filter((c) => !pools.some((p) => p.agentId === c.agentId) && !eligibleAgents.some((e) => e.agentId === c.agentId)),
    [capable, pools, eligibleAgents],
  );

  const resolveAccount = useCallback((agentId: string, memberId: string | null): AgentAccount | undefined => {
    if (memberId === null) return systemAccounts.find((a) => a.agentId === agentId);
    return accounts.find((a) => a.id === memberId);
  }, [accounts, systemAccounts]);

  const memberName = useCallback((agentId: string, memberId: string | null): string => {
    const acc = resolveAccount(agentId, memberId);
    if (acc) return accountDisplayLabel(acc, t("accounts.principalName"));
    return memberId === null ? t("accounts.principalName") : t("accounts.unavailable");
  }, [resolveAccount, t]);

  const togglePause = async (pool: Pool) => {
    const nextPaused = !pool.paused;
    try {
      await poolSetPaused(pool.id, nextPaused);
      AlertaToast(
        pool.name,
        t(nextPaused ? "accounts.pools.pausedToast" : "accounts.pools.resumedToast", { name: pool.name }),
        "success",
        3000,
      );
      refreshPreviews();
    } catch (e) {
      AlertaToast(pool.name, String(e), "error", 6000);
    }
  };

  const copyPoolRef = (pool: Pool) => {
    const ref = `pool:${pool.name}`;
    navigator.clipboard?.writeText(ref)
      .then(() => AlertaToast(pool.name, t("accounts.pools.copiedRef", { ref }), "success", 2500))
      .catch(() => AlertaToast(pool.name, ref, "info", 3500));
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await poolRemove(deleting.id);
      AlertaToast(t("accounts.pools.title"), t("accounts.pools.deletedToast", { name: deleting.name }), "success", 3000);
    } catch (e) {
      AlertaToast(t("accounts.pools.title"), String(e), "error", 6000);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Cartão global: Quando a cota de uma conta acabar */}
      <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[220px]">
            <div className="text-[13.5px] font-semibold text-gray-900 dark:text-white">{t("accounts.pools.mode.title")}</div>
            <div className="text-[12px] text-gray-400 dark:text-white/45">{t("accounts.pools.mode.subtitle")}</div>
          </div>
          <div
            role="radiogroup"
            aria-label={t("accounts.pools.mode.title")}
            className="inline-flex rounded-lg bg-gray-100 dark:bg-white/[0.06] p-0.5 gap-0.5"
          >
            {CHAT_POOL_MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => changeMode(m)}
                className={`h-7 px-3 rounded-md text-[12px] font-medium whitespace-nowrap transition-colors
                  ${mode === m
                    ? "bg-white dark:bg-white/[0.12] text-gray-900 dark:text-white shadow-xs"
                    : "text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white"}`}
              >
                {t(`accounts.pools.mode.${m}`)}
              </button>
            ))}
          </div>
        </div>
        <p className="m-0 mt-2.5 text-[12px] text-gray-500 dark:text-white/55">{t(`accounts.pools.mode.${mode}.desc`)}</p>
        {mode !== "off" && (
          <p className="m-0 mt-1.5 text-[11.5px] text-amber-700 dark:text-amber-400">{t("accounts.pools.mode.policyWarn")}</p>
        )}
        {modeError && <p role="alert" className="m-0 mt-1.5 text-[11.5px] text-red-600 dark:text-red-400">{modeError}</p>}
      </div>

      {/* Cabeçalho da lista de pools */}
      <div className="flex items-center gap-3">
        <span className="flex-1 text-[13px] text-gray-500 dark:text-white/50">
          {t("accounts.pools.listHintBefore")}{" "}
          <code className="rounded bg-gray-100 dark:bg-white/[0.08] px-1 py-px text-[12px]">pool:{t("accounts.pools.nameSample")}</code>{" "}
          {t("accounts.pools.listHintAfter")}
        </span>
        <Button
          variant="primary"
          size="sm"
          disabled={eligibleAgents.length === 0}
          onClick={() => setEditorState({ open: true, pool: null })}
        >
          + {t("accounts.pools.add")}
        </Button>
      </div>

      {/* Lista de pools */}
      <SettingsGroup>
        {pools.length === 0 ? (
          <div className="px-4 py-7 text-center text-[12.5px] text-gray-400 dark:text-white/40">
            {t("accounts.pools.empty")}
          </div>
        ) : (
          pools.map((pool) => {
            const agentLabel = capable.find((c) => c.agentId === pool.agentId)?.label ?? pool.agentId;
            const Icon = agentIcon(pool.agentId, agentLabel);
            const empty = isPoolEmpty(pool, accountsLoaded ? accounts : undefined);
            const paused = Boolean(pool.paused);
            const preview = previews[pool.id];
            const pickedLabel = preview?.available ? memberName(pool.agentId, preview.accountId) : null;
            const firstMemberLabel = empty ? null : memberName(pool.agentId, pool.members[0] ?? null);

            return (
              <div
                key={pool.id}
                data-pool-row={pool.id}
                className={`flex items-start gap-3 px-4 py-3.5 ${paused && !empty ? "opacity-60" : ""}`}
              >
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 dark:bg-white/[0.06] text-gray-700 dark:text-white/80">
                  <Icon className="w-4 h-4" />
                </span>

                <div className="flex-1 min-w-0 flex flex-col gap-2">
                  <div className="flex flex-wrap items-baseline gap-1.5">
                    <b className="text-[13.5px] font-semibold text-gray-900 dark:text-white">{pool.name}</b>
                    <span className="text-[12px] text-gray-400 dark:text-white/45">
                      · {agentLabel} · {t(`accounts.pools.strategy.${pool.strategy}`).toLowerCase()}
                    </span>
                  </div>

                  {empty ? (
                    <div className="flex flex-col gap-1.5">
                      <div className="text-[12.5px] font-medium text-gray-600 dark:text-white/70">
                        {t("accounts.pools.emptyState")}
                      </div>
                      <p className="m-0 text-[12px] text-gray-400 dark:text-white/45">
                        {t("accounts.pools.emptyStateHint")}
                      </p>
                      <div className="flex items-center gap-2 pt-0.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setEditorState({ open: true, pool })}
                        >
                          {t("btn.edit")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 dark:text-red-400"
                          onClick={() => setDeleting(pool)}
                        >
                          {t("btn.delete")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* Cadeia de contas */}
                      <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                        {pool.members.map((memberId, idx) => {
                          const acc = resolveAccount(pool.agentId, memberId);
                          const label = memberName(pool.agentId, memberId);
                          const style = accountBadgeStyle(acc?.accentColor);
                          const pct = usagePercentOf(acc, claude, codex, antigravity, agy);
                          const statusText = acc && !acc.loggedIn
                            ? t("accounts.pools.noLogin")
                            : pct !== null
                              ? `${pct}%`
                              : "—";
                          return (
                            <span key={`${memberId ?? "system"}-${idx}`} className="inline-flex items-center gap-1.5">
                              {idx > 0 && <span aria-hidden="true" className="text-gray-400 dark:text-white/35">→</span>}
                              <span className="inline-flex items-center gap-1.5">
                                <span
                                  aria-hidden="true"
                                  style={style}
                                  className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9.5px] font-semibold
                                    ${style ? "" : "bg-gray-200 text-gray-700 dark:bg-white/12 dark:text-white"}`}
                                >
                                  {accountInitials(label)}
                                </span>
                                <span className="text-gray-800 dark:text-gray-100">{label}</span>
                                <span className="text-[11px] text-gray-400 dark:text-white/40 tabular-nums">{statusText}</span>
                              </span>
                            </span>
                          );
                        })}
                      </div>

                      {/* "Agora escolheria X" vindo do backend (routing::pick_in_pool) */}
                      <div className="text-[12px] text-gray-400 dark:text-white/45">
                        {paused && firstMemberLabel ? (
                          t("accounts.pools.pausedLine", { account: firstMemberLabel })
                        ) : pickedLabel ? (
                          <>
                            {t("accounts.pools.wouldPickPrefix")}{" "}
                            <b className="font-medium text-gray-800 dark:text-white/90">{pickedLabel}</b>
                            {preview && preview.swapsToday > 0 && (
                              <> · {t("accounts.pools.swapsToday", { count: preview.swapsToday })}</>
                            )}
                          </>
                        ) : (
                          t("accounts.pools.noneAvailable")
                        )}
                      </div>
                    </>
                  )}
                </div>

                <PoolOverflowMenu
                  label={t("accounts.pools.menu.more", { name: pool.name })}
                  paused={paused}
                  empty={empty}
                  poolName={pool.name}
                  onEdit={() => setEditorState({ open: true, pool })}
                  onCopy={() => copyPoolRef(pool)}
                  onTogglePause={() => void togglePause(pool)}
                  onDelete={() => setDeleting(pool)}
                />
              </div>
            );
          })
        )}
      </SettingsGroup>

      {agentsWithoutPool.length > 0 && (
        <p className="m-0 mx-0.5 text-[12px] text-gray-400 dark:text-white/40">
          {t("accounts.pools.needTwoAccounts", { agents: agentsWithoutPool.map((a) => a.label).join(", ") })}
        </p>
      )}

      {editorState.open && (
        <PoolEditorDialog
          editing={editorState.pool}
          eligibleAgents={editorState.pool ? capable : eligibleAgents}
          accounts={accounts}
          systemAccounts={systemAccounts}
          onClose={() => setEditorState({ open: false, pool: null })}
          onSaved={refreshPreviews}
          onDelete={(pool) => {
            setEditorState({ open: false, pool: null });
            setDeleting(pool);
          }}
        />
      )}

      {deleting && (
        <AppDialog
          title={t("accounts.pools.deleteDialog.title", { name: deleting.name })}
          onClose={() => setDeleting(null)}
          size="sm"
          footer={
            <>
              <Button variant="outline" onClick={() => setDeleting(null)}>{t("btn.cancel")}</Button>
              <Button variant="danger" onClick={() => void confirmDelete()}>{t("providers.account.remove")}</Button>
            </>
          }
        >
          <p className="m-0 text-[12.5px] text-gray-600 dark:text-white/65">
            {t("accounts.pools.deleteDialog.body", { ref: `pool:${deleting.name}` })}
          </p>
        </AppDialog>
      )}
    </div>
  );
}

/** Mantido para compatibilidade com importadores legados (ex.: `AgentAccountsPane`). */
export function PoolsSection({ agent }: { agent?: AccountCapableAgent } = {}) {
  const { t } = useTranslation();
  const pools = usePools(agent?.agentId);
  const accounts = useAccountsStore((s) => s.accounts);
  const systemAccounts = useAccountsStore((s) => s.systemAccounts);

  if (!agent) return <PoolsTabPage />;

  const total = [...systemAccounts, ...accounts].filter((a) => a.agentId === agent.agentId).length;
  if (total < 2) return null;

  return (
    <section className="shrink-0 mt-2 pt-2 border-t border-gray-200 dark:border-white/8 text-[11.5px] text-gray-500 dark:text-white/50">
      <span className="font-medium text-gray-700 dark:text-gray-200">{t("accounts.pools.title")}</span>
      {pools.length > 0 && (
        <span className="ml-2">{pools.map((p) => p.name).join(", ")}</span>
      )}
    </section>
  );
}
