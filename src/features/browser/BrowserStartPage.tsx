import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { GlobeIcon } from "@/app/icons";
import type { RecentBrowserPage } from "./recentPages";

export function BrowserStartPage({ recentPages, servers, onClearRecent, onNavigate }: {
  recentPages: RecentBrowserPage[];
  servers: string[] | null;
  onClearRecent: () => void;
  onNavigate: (url: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 h-full items-center justify-center overflow-y-auto p-6 bg-gray-50 dark:bg-surface">
      <div className="flex w-full max-w-lg flex-col items-center gap-4 py-6 text-center">
        <span className="flex items-center justify-center w-12 h-12 rounded-2xl bg-accent-500/10 text-accent-600 dark:text-accent-400">
          <GlobeIcon className="w-6 h-6" />
        </span>
        <div>
          <p className="text-[14px] font-semibold text-gray-800 dark:text-gray-100">{t("browser.start.title")}</p>
          <p className="mt-1 text-[12px] text-gray-500 dark:text-white/40">{t("browser.start.desc")}</p>
        </div>
        {recentPages.length > 0 && (
          <section className="w-full text-left">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-white/45">
                {t("browser.start.recent")}
              </h2>
              <Button variant="custom" onClick={onClearRecent} className="cc-t rounded px-1.5 py-1 text-[11px] text-gray-500 hover:bg-gray-200/70 dark:text-white/45 dark:hover:bg-white/8">
                {t("browser.start.clearRecent")}
              </Button>
            </div>
            <div className="flex flex-col gap-1.5">
              {recentPages.map((page) => (
                <Button variant="custom" key={page.url} onClick={() => onNavigate(page.url)}
                  className="cc-t flex w-full min-w-0 flex-col items-start rounded-lg border border-gray-200 bg-white px-3 py-2 text-left hover:border-accent-500 dark:border-white/10 dark:bg-white/4 dark:hover:border-accent-400">
                  <span className="w-full truncate text-[12px] font-medium text-gray-800 dark:text-gray-100">{page.title}</span>
                  <span className="w-full truncate font-mono text-[10px] text-gray-400 dark:text-white/35">
                    {page.url.replace(/^https?:\/\//, "")}
                  </span>
                </Button>
              ))}
            </div>
          </section>
        )}
        <section className="w-full text-left">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-white/45">
            {t("browser.start.servers")}
          </h2>
          {servers === null ? (
            <p className="m-0 text-center text-[11px] text-gray-400 dark:text-white/30">{t("browser.start.detecting")}</p>
          ) : servers.length > 0 ? (
            <div className="flex flex-wrap justify-center gap-1.5">
              {servers.map((url) => (
                <Button variant="custom" key={url} onClick={() => onNavigate(url)}
                  className="cc-t inline-block h-7 rounded-full border border-gray-200 bg-white px-3 font-mono text-[11.5px] text-gray-700 hover:border-accent-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:border-accent-400">
                  {url.replace("http://", "")}
                </Button>
              ))}
            </div>
          ) : (
            <p className="m-0 text-center text-[11px] text-gray-400 dark:text-white/30">{t("browser.start.none")}</p>
          )}
        </section>
      </div>
    </div>
  );
}
