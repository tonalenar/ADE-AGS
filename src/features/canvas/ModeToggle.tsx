import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { setWorkMode, useActiveBoardKey, useWorkMode, type WorkMode } from "./store";

/** Abas ou canvas, para la carpeta del agente activo. Vive en la barra de tabs. */
export function ModeToggle() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const key = useActiveBoardKey();
  const mode = useWorkMode();
  if (!key) return null;

  const option = (value: WorkMode, label: string) => (
    <Button variant="custom"
      onClick={() => { setWorkMode(key, value); navigate("/workspace"); }}
      aria-pressed={mode === value}
      className={`cc-t h-6 px-2.5 rounded-md text-[11.5px] font-medium
        ${mode === value
          ? "bg-white dark:bg-white/12 text-gray-900 dark:text-white shadow-sm"
          : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"}`}
    >
      {label}
    </Button>
  );

  return (
    <div data-tauri-drag-region="false" className="flex items-center gap-0.5 p-0.5 mx-2 my-auto shrink-0 rounded-lg
      bg-gray-200/70 dark:bg-white/5">
      {option("tabs", t("canvas.mode.tabs"))}
      {option("canvas", t("canvas.mode.canvas"))}
    </div>
  );
}
