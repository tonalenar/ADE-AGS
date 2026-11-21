import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAccountsStore } from "@/features/accounts/store";
import { getRoster } from "@/features/runs/ipc";
import type { Roster } from "@/features/runs/types";
import { PopupSelect } from "@/shared/ui/PopupSelect";

import { choosableAccounts, hasChoice } from "../accountChoice";
import { switchThreadAccount } from "./store";

/**
 * A conta de uma conversa aberta: a pessoa escolhe qual das contas do agente usar. A troca é a do pool de contas
 * (a sessão mora no perfil da conta antiga, então a nova abre do zero e recebe um resumo como DADO), só entre
 * turnos e depois de uma confirmação curta. Some quando o agente tem uma conta só.
 */
export function ThreadAccountMenu({ threadId, agentId, accountId, disabled = false }: {
  threadId: string;
  agentId: string;
  /** A conta da conversa; `null` = a principal do agente. */
  accountId: string | null;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [roster, setRoster] = useState<Roster | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const createdAccounts = useAccountsStore((s) => s.accounts);
  const systemAccounts = useAccountsStore((s) => s.systemAccounts);
  const identities = useMemo(() => [...systemAccounts, ...createdAccounts], [systemAccounts, createdAccounts]);

  // Contas nascem e morrem fora da tela: relê a cada troca de conta e quando o turno termina.
  useEffect(() => {
    let alive = true;
    getRoster(false).then((r) => alive && setRoster(r), () => undefined);
    return () => { alive = false; };
  }, [accountId, disabled]);

  const agent = roster?.agents.find((a) => a.agentId === agentId);
  const now = Math.floor(Date.now() / 1000);
  const choiceOptions = useMemo(
    () => ({ currentAccountId: accountId, principalLabel: t("accounts.system"), identities }),
    [accountId, identities, t],
  );
  const accounts = useMemo(() => choosableAccounts(agent, now, choiceOptions), [agent, now, choiceOptions]);
  if (!hasChoice(agent, now, choiceOptions)) return null;

  const nameOf = (value: string) => accounts.find((a) => a.value === value)?.name ?? (value === "" ? t("accounts.system") : value);
  const current = accounts.find((a) => a.value === (accountId ?? ""));
  const expanded = asking !== null || !!error;
  const confirm = async () => {
    if (asking === null) return;
    const target = asking;
    setAsking(null);
    setError(await switchThreadAccount(threadId, target === "" ? null : target));
  };

  // No rodapé do seletor de agente/modelo: em repouso fica alinhado à direita dos outros controles;
  // com confirmação ou erro ocupa a linha inteira (`basis-full`) dentro da largura do popover sem quebrá-lo.
  return (
    <div
      data-thread-account=""
      className={`flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5 min-w-0 max-w-full text-chat-caption text-gray-500 dark:text-white/45 ${expanded ? "basis-full w-full pt-1.5 border-t border-gray-200 dark:border-white/[0.08]" : ""}`}
    >
      <span className={expanded ? "flex-1 min-w-0" : "shrink-0"}>{t("chat.account.label")}</span>
      <PopupSelect value={accountId ?? ""} disabled={disabled} aria-label={t("chat.account.label")} title={t("chat.account.label")}
        onChange={(e) => { setError(null); setAsking(e.target.value === (accountId ?? "") ? null : e.target.value); }}
        className="max-w-44 text-chat-caption">
        {accounts.map((a) => (
          <option key={a.value} value={a.value}>{t("chat.account.option", { name: a.name, state: t(`chat.account.state.${a.state}`) })}</option>
        ))}
      </PopupSelect>
      {current?.state === "exhausted" && <span className="text-chat-caption text-red-600 dark:text-red-400">{t("chat.account.state.exhausted")}</span>}
      {asking !== null && (
        <span role="alertdialog" className="basis-full w-full min-w-0 flex flex-wrap items-center justify-end gap-1.5 text-chat-caption text-gray-600 dark:text-white/60 break-words">
          <span className="min-w-0 break-words">{t("chat.account.confirm", { name: nameOf(asking) })}</span>
          <button type="button" onClick={() => void confirm()} className="h-6 px-2 shrink-0 rounded-md border border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/[0.06]">{t("chat.account.confirmYes")}</button>
          <button type="button" onClick={() => setAsking(null)} className="h-6 px-2 shrink-0 rounded-md border border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/[0.06]">{t("chat.account.confirmNo")}</button>
        </span>
      )}
      {error && <span role="alert" className="basis-full w-full min-w-0 text-chat-caption text-red-600 dark:text-red-400 break-words">{error}</span>}
    </div>
  );
}
