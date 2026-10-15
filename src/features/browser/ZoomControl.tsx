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
  const small = "cc-t flex items-center justify-center w-6 h-7 p-0 rounded-md text-[15px] leading-none shrink-0 " +
    "text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div className="flex items-center shrink-0 h-8 rounded-lg border border-gray-300 dark:border-white/15 px-0.5">
      <Tooltip content={t("browser.zoom.out")} placement="bottom">
        <Button variant="custom" className={small} disabled={disabled || zoom <= MIN_ZOOM} onClick={() => onStep(-1)} aria-label={t("browser.zoom.out")}>−</Button>
      </Tooltip>
      <Tooltip content={t("browser.zoom.reset")} placement="bottom">
        <Button variant="custom" disabled={disabled || zoom === 1} onClick={onReset} aria-label={t("browser.zoom.reset")}
          className="cc-t h-7 min-w-11 px-1 rounded-md font-mono text-[11px] tabular-nums shrink-0 text-gray-700 dark:text-gray-200
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
