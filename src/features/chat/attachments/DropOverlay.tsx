import { useTranslation } from "react-i18next";

import { useDropHighlight } from "./dropRegistry";

/** O realce da coluna do chat enquanto se arrasta um arquivo por cima: "Solte para anexar". Não pega o mouse. */
export function DropOverlay() {
  const { t } = useTranslation();
  const on = useDropHighlight((s) => s.on);
  if (!on) return null;
  return (
    <div role="status" className="absolute inset-0 z-30 pointer-events-none m-2 rounded-2xl border-2 border-dashed border-accent-500/70 bg-accent-500/[0.06] flex items-center justify-center">
      <span className="px-4 h-9 rounded-full flex items-center bg-white dark:bg-surface-raised text-chat-ui font-medium text-gray-900 dark:text-white shadow-lg">
        {t("chat.attach.dropHint")}
      </span>
    </div>
  );
}
