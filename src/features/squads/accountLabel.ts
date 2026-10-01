import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";

export function resolveSquadAccountLabel(
  accountId: string | null,
  autoAccount: boolean,
  accounts: AgentAccount[],
  loaded: boolean,
  translate: (key: string) => string,
): string {
  if (autoAccount) return translate("accounts.auto");
  if (!accountId) return translate("accounts.system");
  const account = accounts.find((entry) => entry.id === accountId);
  if (account) return account.name;
  return translate(loaded ? "squads.accountUnavailable" : "squads.accountLoading");
}

/** Resolve presentation labels from the account roster; Squad storage keeps only account IDs. */
export function useSquadAccountLabel() {
  const { t } = useTranslation();
  const accounts = useAccountsStore((state) => state.accounts);
  const loaded = useAccountsStore((state) => state.loaded);
  const load = useAccountsStore((state) => state.load);

  useEffect(() => {
    if (!loaded) load().catch(console.error);
  }, [loaded, load]);

  return useCallback(
    (accountId: string | null, autoAccount: boolean) => resolveSquadAccountLabel(accountId, autoAccount, accounts, loaded, (key) => t(key)),
    [accounts, loaded, t]
  );
}
