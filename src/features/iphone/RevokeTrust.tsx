import { useState } from "react";
import { useTranslation } from "react-i18next";

import { computerUseForget } from "@/features/chat/devicesIpc";

/**
 * Revoga o "Autorizar sempre" (toques e digitação) e a janela de digitação recente dos aparelhos, sem desligar a chave
 * dos agentes. Só a pessoa chega aqui: é um botão do painel, não um comando do IPC.
 */
export function RevokeTrust() {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const revoke = () => {
    setState("busy");
    computerUseForget().then(() => setState("done"), () => setState("failed"));
  };
  return (
    <button
      type="button"
      className="mt-1 text-chat-caption text-gray-500 underline decoration-dotted underline-offset-2 hover:text-gray-900 disabled:no-underline disabled:opacity-60 dark:text-white/50 dark:hover:text-white"
      disabled={state === "busy"}
      onClick={revoke}
    >
      {t(`iphone.agentRevoke.${state}`)}
    </button>
  );
}
