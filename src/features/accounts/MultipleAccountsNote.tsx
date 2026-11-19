import { useTranslation } from "react-i18next";

import { shouldWarnMultipleAccounts } from "@/features/accounts/multipleAccounts";
import { useAccountsStore } from "@/features/accounts/store";

/**
 * Aviso curto ao adicionar uma 2ª conta de Claude ou Codex. Não bloqueia: a ADE suporta várias contas,
 * mas cada uma tem a própria cota e as regras do plano são de quem o vende.
 */
export function MultipleAccountsNote({ agentId, agentLabel }: { agentId: string; agentLabel: string }) {
  const { t } = useTranslation();
  const accounts = useAccountsStore((s) => s.accounts);
  const systemAccounts = useAccountsStore((s) => s.systemAccounts);
  if (!shouldWarnMultipleAccounts(agentId, accounts, systemAccounts)) return null;
  return (
    <p role="note" className="rounded-lg px-3 py-2 text-[11.5px] leading-4
      bg-amber-500/10 text-amber-800 dark:text-amber-300">
      {t("accounts.multipleNote", { agent: agentLabel })}
    </p>
  );
}
