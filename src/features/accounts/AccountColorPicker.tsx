import { useTranslation } from "react-i18next";

import { ACCOUNT_COLORS } from "@/features/accounts/accountIdentity";

/**
 * A paleta de cores do selo: um botão por token do tema, mais "sem cor". Escolher grava o
 * NOME do token (`green`), nunca um hex.
 */
export function AccountColorPicker({ value, onChange, label }: {
  value: string | null;
  onChange: (token: string | null) => void;
  label: string;
}) {
  const { t } = useTranslation();
  const ring = "ring-2 ring-offset-2 ring-gray-900 dark:ring-white ring-offset-white dark:ring-offset-surface";
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        aria-label={t("accounts.color.none")}
        title={t("accounts.color.none")}
        onClick={() => onChange(null)}
        className={`cc-t w-6 h-6 rounded-full border border-dashed border-gray-400 dark:border-white/40
          text-[11px] leading-none text-gray-500 dark:text-white/50 ${value === null ? ring : ""}`}
      >
        ∅
      </button>
      {ACCOUNT_COLORS.map((color) => (
        <button
          key={color.token}
          type="button"
          role="radio"
          aria-checked={value === color.token}
          aria-label={t(`accounts.color.${color.token}`)}
          title={t(`accounts.color.${color.token}`)}
          onClick={() => onChange(color.token)}
          style={{ backgroundColor: color.background }}
          className={`cc-t w-6 h-6 rounded-full ${value === color.token ? ring : ""}`}
        />
      ))}
    </div>
  );
}
