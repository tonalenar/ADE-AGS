import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { CHAT_POOL_MODES, loadChatPoolMode, saveChatPoolMode, type ChatPoolMode } from "./chatPool";

/**
 * O interruptor global do pool de contas no chat. Desligado por padrão; só a pessoa liga. Ligar mostra a
 * ressalva de política dos provedores: o pool serve a contas da própria pessoa.
 */
export function ChatPoolModeSwitch() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ChatPoolMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadChatPoolMode().then(setMode);
  }, []);

  const pick = (next: ChatPoolMode) => {
    setError(null);
    saveChatPoolMode(next).then(() => setMode(next), (e) => setError(String(e)));
  };

  if (mode === null) return null;
  return (
    <div className="mb-3 rounded-lg border border-gray-200 dark:border-white/8 p-2.5">
      <div className="text-[12px] font-medium text-gray-800 dark:text-gray-100">{t("accounts.chatPool.title")}</div>
      <p className="mt-0.5 mb-2 text-[11px] leading-relaxed text-gray-500 dark:text-white/40">{t("accounts.chatPool.hint")}</p>
      <div role="radiogroup" aria-label={t("accounts.chatPool.title")} className="flex flex-wrap gap-1.5">
        {CHAT_POOL_MODES.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => pick(m)}
            title={t(`accounts.chatPool.mode.${m}.hint`)}
            className={`cc-t px-2 h-6 rounded-md border text-[11px]
              ${mode === m
                ? "border-accent-500 bg-accent-50 dark:bg-accent-500/10 text-accent-700 dark:text-accent-300"
                : "border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:border-gray-300"}`}>
            {t(`accounts.chatPool.mode.${m}`)}
          </button>
        ))}
      </div>
      {mode !== "off" && <p className="mt-2 mb-0 text-[10.5px] leading-relaxed text-amber-700 dark:text-amber-400">{t("accounts.chatPool.policy")}</p>}
      {error && <p role="alert" className="mt-1 mb-0 text-[10.5px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
