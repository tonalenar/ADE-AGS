import { PopupSelect } from "@/shared/ui/PopupSelect";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, CloseIcon, Tooltip } from "neogestify-ui-components";

import { RotateIcon } from "@/app/icons";

import { breakpointOf, clampViewport, presetOf, rotate, VIEWPORT_PRESETS, type Viewport } from "./viewport";

/** Los cortes de Tailwind, con el ancho al que salta cada uno. `xs` no tiene mínimo: se
 *  prueba en el teléfono chico, que es el caso real por debajo de `sm`. */
const BREAKPOINT_WIDTHS: [string, number][] = [["xs", 360], ["sm", 640], ["md", 768], ["lg", 1024], ["xl", 1280], ["2xl", 1536]];

function SideInput({ value, label, onCommit }: { value: number; label: string; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number.parseInt(text, 10);
    if (Number.isFinite(n)) onCommit(n);
    else setText(String(value));
  };
  return (
    <input
      value={text}
      aria-label={label}
      inputMode="numeric"
      onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          onCommit(value + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1));
        }
      }}
      className="w-14 h-6 px-1.5 rounded-md text-center font-mono text-[11.5px] tabular-nums outline-none
        bg-white dark:bg-white/6 border border-gray-300 dark:border-white/12
        focus:border-accent-500 dark:focus:border-accent-400 text-gray-900 dark:text-gray-100"
    />
  );
}

/** Os aparelhos que a página pode achar que é. `null` = navegador de mesa. */
const PLATFORMS: { id: "ios" | "android" | null; key: string }[] = [
  { id: "ios", key: "browser.viewport.ios" },
  { id: "android", key: "browser.viewport.android" },
  { id: null, key: "browser.viewport.desktop" },
];

/** A barra do modo celular, numa linha: tamanho, girar, aparelho emulado e fechar. Os breakpoints do
 *  Tailwind ficam no próprio seletor de tamanho, e o atual aparece ao lado das medidas. */
export function DeviceBar({ viewport, mobile, onChange, onMobile, onClose }: {
  viewport: Viewport;
  /** Aparelho emulado (user agent, densidade e toque); `null` = mesa. */
  mobile: "ios" | "android" | null;
  onChange: (viewport: Viewport) => void;
  onMobile: (platform: "ios" | "android" | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const match = presetOf(viewport);
  const current = breakpointOf(viewport.width);
  const set = (v: Viewport) => onChange(clampViewport(v));

  return (
    <div className="flex items-center gap-2 h-9 shrink-0 px-2 overflow-hidden
      border-b border-gray-200 dark:border-white/7 bg-white/60 dark:bg-white/2">
      <div className="w-44 min-w-0 shrink">
        <PopupSelect
          value={match?.preset.id ?? "custom"}
          onChange={(e) => {
            const value = e.target.value;
            const bp = BREAKPOINT_WIDTHS.find(([name]) => `bp:${name}` === value);
            if (bp) { set({ ...viewport, width: bp[1] }); return; }
            const preset = VIEWPORT_PRESETS.find((p) => p.id === value);
            if (preset) set(match?.rotated ? rotate(preset) : preset);
          }}>
          <option value="custom">{t("browser.viewport.custom")}</option>
          {VIEWPORT_PRESETS.map((p) => <option key={p.id} value={p.id}>{`${t(`browser.viewport.preset.${p.id}`)} · ${p.width}×${p.height}`}</option>)}
          {BREAKPOINT_WIDTHS.map(([name, width]) => <option key={name} value={`bp:${name}`}>{t("browser.viewport.jumpTo", { name, width })}</option>)}
        </PopupSelect>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <SideInput value={viewport.width} label={t("browser.viewport.width")} onCommit={(width) => set({ ...viewport, width })} />
        <span className="text-[11px] text-gray-400 dark:text-white/30">×</span>
        <SideInput value={viewport.height} label={t("browser.viewport.height")} onCommit={(height) => set({ ...viewport, height })} />
        {current && (
          <span title={t("browser.viewport.breakpoints")}
            className="ml-0.5 px-1 rounded font-mono text-[10px] text-gray-500 dark:text-white/45 bg-gray-100 dark:bg-white/6">{current}</span>
        )}
      </div>

      <Tooltip content={t("browser.viewport.rotate")} placement="bottom">
        <Button variant="icon" onClick={() => set(rotate(viewport))} aria-label={t("browser.viewport.rotate")}
          className="cc-t flex items-center justify-center w-7 h-7 p-0 rounded-md shrink-0
            text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/10">
          <RotateIcon className="w-4 h-4" />
        </Button>
      </Tooltip>

      <div className="flex-1" />

      <div role="radiogroup" aria-label={t("browser.viewport.platform")}
        className="flex items-center shrink-0 rounded-md p-0.5 bg-gray-100 dark:bg-white/6">
        {PLATFORMS.map((p) => (
          <button key={p.key} type="button" role="radio" aria-checked={mobile === p.id} onClick={() => onMobile(p.id)}
            className={`cc-t h-6 px-2 rounded text-[11px] font-medium
              ${mobile === p.id
                ? "bg-white text-gray-900 shadow-sm dark:bg-white/15 dark:text-white"
                : "text-gray-500 hover:text-gray-900 dark:text-white/50 dark:hover:text-white"}`}>
            {t(p.key)}
          </button>
        ))}
      </div>

      <Tooltip content={t("browser.viewport.exit")} placement="bottom">
        <Button variant="icon" onClick={onClose} aria-label={t("browser.viewport.exit")}
          className="cc-t flex items-center justify-center w-7 h-7 p-0 rounded-md shrink-0
            text-gray-500 dark:text-white/45 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
          <CloseIcon className="w-3.5 h-3.5" />
        </Button>
      </Tooltip>
    </div>
  );
}
