import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";
import { Terminal } from "@/features/terminal/Terminal";
import { detectAgents } from "@/features/agents/ipc";

/** Uses the CLI's native login and OS keyring, without copying credentials. */
export function AntigravityAccountsPane() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let stale = false;
    detectAgents().then((agents) => {
      if (!stale) setInstalled(agents.some((a) => a.id === "antigravity" && a.available));
    }).catch((e) => { if (!stale) setError(String(e)); });
    return () => { stale = true; };
  }, []);
  return (
    <div className="flex flex-col gap-3 p-4 min-h-0 flex-1 overflow-y-auto">
      <h3 className="text-sm font-semibold">Antigravity</h3>

      <p className="text-xs text-gray-500">{t("accounts.antigravity.description")}</p>
      <p className="text-xs text-gray-500">{t("accounts.antigravity.scope")}</p>
      <p className="text-xs text-gray-500">{t("accounts.antigravity.multipleAccounts")}</p>
      <Button disabled={!installed} onClick={() => setOpen(!open)}>
        {t(open ? "accounts.antigravity.close" : "accounts.antigravity.connect")}
      </Button>
      {!installed && <p className="text-xs text-gray-500">{t("accounts.antigravity.installRequired")}</p>}
      {error && <p className="text-xs text-red-500">{error}</p>}
      {open && <div className="h-96 min-h-0 overflow-hidden rounded-lg border border-gray-200 dark:border-white/10">
        <Terminal command="agy" isActive />
      </div>}
      <a className="text-xs text-accent-500" href="https://antigravity.google/docs/cli/install/" target="_blank" rel="noreferrer">
        {t("accounts.antigravity.docs")}
      </a>
    </div>
  );
}
