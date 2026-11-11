import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsGroup, SettingsSection } from "@/features/settings/SettingsSection";
import { filterLicenses, licenseGroups, type LicenseItem, type LicensesData } from "@/features/settings/licensesModel";

/**
 * Carrega a lista só quando a página abre: são mais de mil pacotes e ela não precisa estar no pacote
 * inicial da tela. O JSON vem de `bun run licenses:gen`.
 */
function useLicensesData(): { data: LicensesData | null; failed: boolean } {
  const [state, setState] = useState<{ data: LicensesData | null; failed: boolean }>({ data: null, failed: false });
  useEffect(() => {
    let alive = true;
    import("@/features/settings/licenses.generated.json")
      .then((mod) => {
        if (alive) setState({ data: mod.default as LicensesData, failed: false });
      })
      .catch(() => {
        if (alive) setState({ data: null, failed: true });
      });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

/** A licença de uma linha: "não lida" e "sem licença" são textos próprios, nunca um chute. */
function LicenseText({ item }: { item: LicenseItem }) {
  const { t } = useTranslation();
  if (item.lida === false) return <span className="italic text-gray-400 dark:text-white/40">{t("settings.licenses.notRead")}</span>;
  if (!item.license) return <span className="italic text-gray-400 dark:text-white/40">{t("settings.licenses.none")}</span>;
  return <span title={item.licencaDe ? t("settings.licenses.viaSibling", { pkg: item.licencaDe }) : undefined}>{item.license}</span>;
}

/**
 * Configurações → Licenças (como o T3 Code). Lista as dependências de terceiros com a versão e a licença
 * declarada, com busca. Quem mantém a lista roda `bun run licenses:gen` depois de mudar dependências.
 */
export function LicensesSetting() {
  const { t } = useTranslation();
  const { data, failed } = useLicensesData();
  const [query, setQuery] = useState("");
  const shown = useMemo(() => (data ? filterLicenses(data.itens, query) : []), [data, query]);
  const groups = useMemo(() => (data ? licenseGroups(data.itens).slice(0, 6) : []), [data]);

  return (
    <SettingsSection title={t("settings.licenses.title")} description={t("settings.licenses.desc")}>
      <SettingsGroup>
        <div className="flex flex-col gap-3 px-4 py-3.5">
          {failed && <p className="m-0 text-[13px] text-red-600 dark:text-red-400">{t("settings.licenses.error")}</p>}
          {!data && !failed && <p className="m-0 text-[13px] text-gray-500 dark:text-white/50">{t("settings.licenses.loading")}</p>}
          {data && (
            <>
              <p className="m-0 text-[13px] text-gray-600 dark:text-white/60">
                {t("settings.licenses.summary", { total: data.contagem.total, npm: data.contagem.npm, crates: data.contagem.crates })}
              </p>
              <ul aria-label={t("settings.licenses.groups")} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                {groups.map((group) => (
                  <li key={group.license ?? "none"} className="rounded-md bg-gray-100 px-2 py-0.5 text-[12px] text-gray-600 dark:bg-white/[0.06] dark:text-white/60">
                    {group.license ?? t("settings.licenses.none")} · {group.count}
                  </li>
                ))}
              </ul>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("settings.licenses.search")}
                aria-label={t("settings.licenses.search")}
                className="h-8 w-full rounded-lg border border-gray-200 bg-white px-2.5 text-[13px] text-gray-900
                  placeholder:text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40
                  dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-white dark:placeholder:text-white/35"
              />
              {shown.length === 0 ? (
                <p className="m-0 text-[13px] text-gray-500 dark:text-white/50">{t("settings.licenses.empty")}</p>
              ) : (
                <ul aria-label={t("settings.licenses.list")} className="cc-scroll m-0 max-h-[420px] list-none overflow-y-auto p-0 text-[12.5px]">
                  {shown.map((item) => (
                    <li key={`${item.ecosystem}:${item.name}@${item.version}`}
                      className="flex items-baseline gap-3 border-b border-gray-100 py-1.5 last:border-0 dark:border-white/[0.06]">
                      <span className="min-w-0 flex-1 truncate font-mono text-gray-900 dark:text-white">{item.name}</span>
                      <span className="shrink-0 font-mono text-gray-400 dark:text-white/40">{item.version}</span>
                      <span className="shrink-0 rounded bg-gray-100 px-1 text-[11px] text-gray-500 dark:bg-white/[0.06] dark:text-white/50">{item.ecosystem}</span>
                      <span className="w-[200px] shrink-0 truncate text-right text-gray-600 dark:text-white/60"><LicenseText item={item} /></span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="m-0 text-[12px] leading-[17px] text-gray-400 dark:text-white/40">{t("settings.licenses.regen")}</p>
            </>
          )}
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}
