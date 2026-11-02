import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

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

  // Contas nascem e morrem fora da tela: relê a cada troca de conta e quando o turno termina.
  useEffect(() => {
    let alive = true;
    getRoster(false).then((r) => alive && setRoster(r), () => undefined);
    return () => { alive = false; };
  }, [accountId, disabled]);

  const agent = roster?.agents.find((a) => a.agentId === agentId);
  const now = Math.floor(Date.now() / 1000);
  const accounts = useMemo(() => choosableAccounts(agent, now), [agent, now]);
  if (!hasChoice(agent)) return null;

  const nameOf = (value: string) => (value === "" ? t("accounts.system") : accounts.find((a) => a.value === value)?.name ?? value);
  const current = accounts.find((a) => a.value === (accountId ?? ""));
  const confirm = async () => {
    if (asking === null) return;
    const target = asking;
    setAsking(null);
    setError(await switchThreadAccount(threadId, target === "" ? null : target));
  };

  return (
    <div className="flex items-center gap-1.5">
      <PopupSelect value={accountId ?? ""} disabled={disabled} aria-label={t("chat.account.label")} title={t("chat.account.label")}
        onChange={(e) => { setError(null); setAsking(e.target.value === (accountId ?? "") ? null : e.target.value); }}
        className="max-w-40 text-chat-caption">
        {accounts.map((a) => (
          <option key={a.value} value={a.value}>{t("chat.account.option", { name: nameOf(a.value), state: t(`chat.account.state.${a.state}`) })}</option>
        ))}
      </PopupSelect>
      {current?.state === "exhausted" && <span className="text-chat-caption text-red-600 dark:text-red-400">{t("chat.account.state.exhausted")}</span>}
      {asking !== null && (
        <span role="alertdialog" className="flex items-center gap-1.5 text-chat-caption text-gray-600 dark:text-white/60">
          {t("chat.account.confirm", { name: nameOf(asking) })}
          <button type="button" onClick={() => void confirm()} className="h-6 px-2 rounded-md border border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/[0.06]">{t("chat.account.confirmYes")}</button>
          <button type="button" onClick={() => setAsking(null)} className="h-6 px-2 rounded-md border border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/[0.06]">{t("chat.account.confirmNo")}</button>
        </span>
      )}
      {error && <span role="alert" className="text-chat-caption text-red-600 dark:text-red-400 break-words">{error}</span>}
    </div>
  );
}
