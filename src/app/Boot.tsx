import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";

import App from "@/app/App";

type DbPhase = "checking" | "upgrading" | "ready";

async function readDbPhase(): Promise<DbPhase> {
  const status = await invoke<{ phase: string }>("db_boot_status");
  return status.phase === "upgrading" ? "upgrading" : "ready";
}

/**
 * A primeira coisa que a janela pinta.
 *
 * No caminho comum a base já está pronta e isto só espera o catálogo. Quando há
 * upgrade, a home não monta: a cópia consistente e a migração ainda estão
 * rodando, e qualquer escrita nesse meio veria o schema velho. A tela diz isso
 * e não oferece ação que grave.
 */
export function Boot({ appReady }: { appReady: Promise<void> }) {
  const [db, setDb] = useState<DbPhase>("checking");
  const [catalogReady, setCatalogReady] = useState(false);

  useEffect(() => {
    let cancel = false;
    appReady.then(() => {
      if (!cancel) setCatalogReady(true);
    });
    return () => {
      cancel = true;
    };
  }, [appReady]);

  useEffect(() => {
    let cancel = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const first = await readDbPhase();
        if (cancel) return;
        if (first === "ready") {
          setDb("ready");
          return;
        }
        setDb("upgrading");
        unlisten = await listen("cc-db-ready", () => {
          if (!cancel) setDb("ready");
        });
        const again = await readDbPhase();
        if (!cancel && again === "ready") setDb("ready");
      } catch {
        if (!cancel) setDb("ready");
      }
    })();
    return () => {
      cancel = true;
      unlisten?.();
    };
  }, []);

  if (db === "upgrading") return <UpdatingSplash />;
  if (db !== "ready" || !catalogReady) return null;
  return <App />;
}

function UpdatingSplash() {
  const { t } = useTranslation();
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-[#1c1c1e] px-8 text-white">
      <p className="text-[17px] font-medium">{t("boot.updating.title")}</p>
      <p className="max-w-md text-center text-[13px] leading-relaxed text-white/70">
        {t("boot.updating.body")}
      </p>
    </div>
  );
}
