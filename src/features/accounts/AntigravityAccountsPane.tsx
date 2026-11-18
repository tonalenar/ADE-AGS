import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";
import { Terminal } from "@/features/terminal/LazyTerminal";
import { detectAgents } from "@/features/agents/ipc";
import { openExternalUrl } from "@/shared/openExternalUrl";
import { PanelBoundary } from "@/app/PanelBoundary";
import { AntigravityOAuthSection } from "./AntigravityOAuthSection";

/** Uses the CLI's native login and OS keyring, without copying credentials. */
export function AntigravityAccountsPane() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // `null` = ainda detectando (ou a detecção falhou): não se diz "instalação necessária" sem saber.
  const [installed, setInstalled] = useState<boolean | null>(null);
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
      {/* O que não é terminal fica em fronteiras: um erro aqui não derruba o terminal do agy (abaixo), que
          está ao lado e não dentro delas. */}
      <PanelBoundary name="antigravity-topo">
        <h3 className="text-sm font-semibold">Antigravity</h3>

        <p className="text-xs text-gray-500">{t("accounts.antigravity.description")}</p>
        <p className="text-xs text-gray-500">{t("accounts.antigravity.scope")}</p>
        <p className="text-xs text-gray-500">{t("accounts.antigravity.multipleAccounts")}</p>
        <Button disabled={installed !== true} onClick={() => setOpen(!open)}>
          {t(open ? "accounts.antigravity.close" : "accounts.antigravity.connect")}
        </Button>
        {installed === false && <p className="text-xs text-gray-500">{t("accounts.antigravity.installRequired")}</p>}
        {error && <p className="text-xs text-red-500">{error}</p>}
      </PanelBoundary>
      {/* Terminal de login do agy: sem fronteira de propósito. Desmontá-lo mata o processo de login. */}
      {open && <div className="h-96 min-h-0 overflow-hidden rounded-lg border border-gray-200 dark:border-white/10">
        <Terminal command="agy" isActive />
      </div>}
      <PanelBoundary name="antigravity-rodape">
        <AntigravityOAuthSection />
        <a className="text-xs text-accent-500" href="https://antigravity.google/docs/cli/install/" target="_blank" rel="noreferrer"
          onClick={(event) => { event.preventDefault(); openExternalUrl("https://antigravity.google/docs/cli/install/").catch(console.error); }}>
          {t("accounts.antigravity.docs")}
        </a>
      </PanelBoundary>
    </div>
  );
}
