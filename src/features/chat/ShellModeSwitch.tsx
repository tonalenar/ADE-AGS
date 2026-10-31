import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useChatShell, useUiStore } from "@/app/uiStore";
import { setWorkMode, useActiveBoardKey, useWorkMode, type WorkMode } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";

type Choice = "chat" | WorkMode;

/**
 * Chat, Abas ou Canvas. Abas e Canvas continuam sendo o modo de cada pasta (`WorkMode`); o chat é a
 * casca da janela inteira. Some com o modo chat desligado: aí quem troca abas/canvas é o `ModeToggle`.
 */
export function ShellModeSwitch({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const enabled = useUiStore((s) => s.chatMode);
  const setShellMode = useUiStore((s) => s.setShellMode);
  const chat = useChatShell();
  const workMode = useWorkMode();
  const boardKey = useActiveBoardKey();
  const hasTabs = useTabsStore((s) => s.tabs.length > 0);
  if (!enabled) return null;

  const current: Choice = chat ? "chat" : workMode;
  const pick = (choice: Choice) => {
    if (choice === "chat") {
      setShellMode("chat");
      return;
    }
    setShellMode("workspace");
    if (boardKey) setWorkMode(boardKey, choice);
    // Sem abas, o workspace manda de volta à inicial (ver `AppShell`).
    navigate(hasTabs ? "/workspace" : "/");
  };

  const options: { value: Choice; label: string }[] = [
    { value: "chat", label: t("chat.mode.chat") },
    { value: "tabs", label: t("canvas.mode.tabs") },
    // O canvas é por pasta: sem uma aba ativa não há canvas para abrir.
    ...(boardKey ? [{ value: "canvas" as const, label: t("canvas.mode.canvas") }] : []),
  ];

  return (
    <div role="group" aria-label={t("chat.mode.label")} title={`${t("chat.mode.label")} (Ctrl+Shift+L)`}
      data-tauri-drag-region="false"
      className={`flex items-center gap-0.5 p-0.5 h-7 shrink-0 rounded-lg bg-black/5 dark:bg-white/[0.07] ${className}`}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={current === option.value}
          onClick={() => pick(option.value)}
          className={`cc-t h-6 px-2.5 rounded-md text-[11.5px] font-medium
            ${current === option.value
              ? "bg-white dark:bg-surface-overlay text-gray-900 dark:text-white shadow-sm"
              : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"}`}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
