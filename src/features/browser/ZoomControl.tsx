import { useTranslation } from "react-i18next";
import { Button, Tooltip } from "neogestify-ui-components";

import { MAX_ZOOM, MIN_ZOOM, zoomLabel } from "./zoom";

/**
 * O zoom da página na barra do navegador: "−  100%  +". Clicar na porcentagem volta a 100%.
 * Muda o tamanho da PÁGINA, não o do navegador (no canvas, o nó continua do mesmo tamanho).
 */
export function ZoomControl({ zoom, disabled, onStep, onReset }: {
  zoom: number;
  disabled?: boolean;
  onStep: (dir: 1 | -1) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const small = "cc-t flex size-6 items-center justify-center rounded-md border border-gray-300 p-0 text-sm leading-none shrink-0 " +
    "text-gray-700 dark:border-white/15 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip content={t("browser.zoom.out")} placement="bottom">
        <Button variant="custom" className={small} disabled={disabled || zoom <= MIN_ZOOM} onClick={() => onStep(-1)} aria-label={t("browser.zoom.out")}>−</Button>
      </Tooltip>
      <Tooltip content={t("browser.zoom.reset")} placement="bottom">
        <Button variant="custom" disabled={disabled || zoom === 1} onClick={onReset} aria-label={t("browser.zoom.reset")}
          className="cc-t h-6 min-w-12 shrink-0 rounded-md px-1 font-sans text-xs tabular-nums text-gray-600 dark:text-gray-300
            hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-100 disabled:hover:bg-transparent">
          {zoomLabel(zoom)}
        </Button>
      </Tooltip>
      <Tooltip content={t("browser.zoom.in")} placement="bottom">
        <Button variant="custom" className={small} disabled={disabled || zoom >= MAX_ZOOM} onClick={() => onStep(1)} aria-label={t("browser.zoom.in")}>+</Button>
      </Tooltip>
    </div>
  );
}
