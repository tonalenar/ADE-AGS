import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";
import { usagePriceClear, usagePriceSet, usagePricesGet, type PricesView } from "@/features/settings/ipc";
import { parsePriceInput } from "@/features/settings/usagePricesModel";

const FIELD =
  "h-8 rounded-lg border border-gray-200 bg-white px-2.5 text-[13px] text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-white";

/**
 * Configurações → Uso e preços (como o T3 Code). A estimação de custo usa a tabela de lista; aqui a pessoa fixa
 * o preço de um modelo, e esse preço ganha da tabela. Assinatura não cobra por token: é só uma referência.
 */
export function UsagePricesSettings() {
  const { t } = useTranslation();
  const [view, setView] = useState<PricesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");

  useEffect(() => {
    usagePricesGet()
      .then(setView)
      .catch(() => setError(t("settings.usage.prices.error")));
  }, [t]);

  const save = async () => {
    const inputPrice = parsePriceInput(input);
    const outputPrice = parsePriceInput(output);
    if (inputPrice === null || outputPrice === null) {
      setError(t("settings.usage.prices.invalidNumber"));
      return;
    }
    try {
      setView(await usagePriceSet(model, inputPrice, outputPrice));
      setModel("");
      setInput("");
      setOutput("");
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : t("settings.usage.prices.error"));
    }
  };

  const remove = async (name: string) => {
    try {
      setView(await usagePriceClear(name));
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : t("settings.usage.prices.error"));
    }
  };

  return (
    <SettingsSection title={t("settings.usage.prices.title")} description={t("settings.usage.prices.desc")}>
      <SettingsGroup>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={t("settings.usage.prices.model.placeholder")}
            aria-label={t("settings.usage.prices.model")} className={`${FIELD} min-w-[180px] flex-1`} />
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t("settings.usage.prices.input")}
            aria-label={t("settings.usage.prices.input")} className={`${FIELD} w-24 tabular-nums`} />
          <input value={output} onChange={(e) => setOutput(e.target.value)} placeholder={t("settings.usage.prices.output")}
            aria-label={t("settings.usage.prices.output")} className={`${FIELD} w-24 tabular-nums`} />
          <Button variant="outline" size="sm" disabled={!model.trim() || !input || !output} onClick={() => void save()}>
            {t("settings.usage.prices.save")}
          </Button>
        </div>
        {error && <p role="alert" className="m-0 px-4 pb-3 text-[12.5px] text-red-600 dark:text-red-400">{error}</p>}
      </SettingsGroup>

      <SettingsGroup>
        {view === null && !error && <p className="m-0 px-4 py-3.5 text-[13px] text-gray-500 dark:text-white/50">{t("settings.usage.prices.loading")}</p>}
        {view?.overrides.length === 0 && <p className="m-0 px-4 py-3.5 text-[13px] text-gray-500 dark:text-white/50">{t("settings.usage.prices.empty")}</p>}
        {view?.overrides.map((o) => (
          <SettingsRow key={o.model} label={o.model} hint={t("settings.usage.prices.perMillion", { input: o.input, output: o.output })}>
            <Button variant="outline" size="sm" onClick={() => void remove(o.model)}>{t("settings.usage.prices.remove")}</Button>
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup>
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <span className="text-[14px] font-medium text-gray-900 dark:text-white">{t("settings.usage.prices.list")}</span>
          <p className="m-0 text-[12.5px] text-gray-500 dark:text-white/50">{t("settings.usage.prices.listNote")}</p>
          <table className="w-full border-collapse text-left text-[12.5px]">
            <thead>
              <tr className="text-gray-400 dark:text-white/40">
                <th className="py-1 font-normal">{t("settings.usage.prices.family")}</th>
                <th className="py-1 text-right font-normal">{t("settings.usage.prices.input")}</th>
                <th className="py-1 text-right font-normal">{t("settings.usage.prices.output")}</th>
              </tr>
            </thead>
            <tbody className="text-gray-700 dark:text-white/70">
              {view?.list.map((row) => (
                <tr key={row.family} className="border-t border-gray-100 dark:border-white/[0.06]">
                  <td className="py-1">{row.family}</td>
                  <td className="py-1 text-right tabular-nums">{row.input}</td>
                  <td className="py-1 text-right tabular-nums">{row.output}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}
