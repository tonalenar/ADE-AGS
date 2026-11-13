import { PopupSelect } from "@/shared/ui/PopupSelect";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, CloseIcon, Tooltip } from "neogestify-ui-components";

import { RotateIcon } from "@/app/icons";

import { clampViewport, isFillViewport, presetOf, rotate, VIEWPORT_PRESETS, type Viewport } from "./viewport";

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

/** Quem a página acha que é: iPhone, Android ou o navegador de mesa (computador). */
const PLATFORMS: { id: "ios" | "android" | null; key: string }[] = [
  { id: "ios", key: "browser.viewport.ios" },
  { id: "android", key: "browser.viewport.android" },
  { id: null, key: "browser.viewport.desktop" },
];

function Segmented<T extends string | null>({ label, value, options, onPick }: {
  label: string;
  value: T;
  options: { id: T; node: React.ReactNode; title?: string }[];
  onPick: (id: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center shrink-0 rounded-md p-0.5 bg-gray-100 dark:bg-white/6">
      {options.map((o) => (
        <button key={String(o.id)} type="button" role="radio" aria-checked={value === o.id} title={o.title} onClick={() => onPick(o.id)}
          className={`cc-t h-6 px-2 rounded text-[11px] font-medium flex items-center justify-center
            ${value === o.id
              ? "bg-white text-gray-900 shadow-sm dark:bg-white/15 dark:text-white"
              : "text-gray-500 hover:text-gray-900 dark:text-white/50 dark:hover:text-white"}`}>
          {o.node}
        </button>
      ))}
    </div>
  );
}

/**
 * A barra do modo celular. Linha 1: o aparelho que a página acha que é (iPhone, Android, Desktop), como ele se mostra
 * (num mockup do aparelho ou preenchendo a coluna inteira) e fechar. Linha 2, só com o mockup: o tamanho da tela e girar.
 * `viewport` `null` é o "completo" de um celular: sem quadro, a página ocupa a coluna.
 */
export function DeviceBar({ viewport, mobile, onChange, onMobile, onFull, onClose }: {
  viewport: Viewport | null;
  /** Aparelho emulado (user agent, densidade e toque); `null` = mesa. */
  mobile: "ios" | "android" | null;
  onChange: (viewport: Viewport) => void;
  onMobile: (platform: "ios" | "android" | null) => void;
  /** `true` = preencher a coluna; `false` = voltar ao mockup do aparelho. */
  onFull: (full: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const framed = !!viewport && !isFillViewport(viewport);
  const match = viewport ? presetOf(viewport) : undefined;
  const set = (v: Viewport) => onChange(clampViewport(v));

  return (
    <div className="shrink-0 border-b border-gray-200 dark:border-white/7 bg-white/60 dark:bg-white/2">
      <div className="flex items-center gap-2 h-9 px-2">
        <Segmented label={t("browser.viewport.platform")} value={mobile}
          options={PLATFORMS.map((p) => ({ id: p.id, node: t(p.key) }))} onPick={onMobile} />
        <Segmented label={t("browser.viewport.layout")} value={framed ? "frame" : "full"}
          options={[
            { id: "frame", node: t("browser.viewport.frame"), title: t("browser.viewport.frameHint") },
            { id: "full", node: t("browser.viewport.full"), title: t("browser.viewport.fullHint") },
          ]}
          onPick={(id) => onFull(id === "full")} />
        <div className="flex-1" />
        <Tooltip content={t("browser.viewport.exit")} placement="bottom">
          <Button variant="icon" onClick={onClose} aria-label={t("browser.viewport.exit")}
            className="cc-t flex items-center justify-center w-7 h-7 p-0 rounded-md shrink-0
              text-gray-500 dark:text-white/45 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
            <CloseIcon className="w-3.5 h-3.5" />
          </Button>
        </Tooltip>
      </div>

      {framed && viewport && (
        <div className="flex items-center gap-2 h-9 px-2 border-t border-gray-100 dark:border-white/5">
          <div className="w-32 shrink-0">
            <PopupSelect
              className="w-full h-7 text-[12px]"
              value={match?.preset.id ?? "custom"}
              onChange={(e) => {
                const value = e.target.value;
                const bp = BREAKPOINT_WIDTHS.find(([name]) => `bp:${name}` === value);
                if (bp) { set({ ...viewport, width: bp[1] }); return; }
                const preset = VIEWPORT_PRESETS.find((p) => p.id === value);
                if (preset) set(match?.rotated ? rotate(preset) : preset);
              }}>
              <option value="custom">{t("browser.viewport.custom")}</option>
              {VIEWPORT_PRESETS.map((p) => <option key={p.id} value={p.id}>{t(`browser.viewport.preset.${p.id}`)}</option>)}
              {BREAKPOINT_WIDTHS.map(([name, width]) => <option key={name} value={`bp:${name}`}>{t("browser.viewport.jumpTo", { name, width })}</option>)}
            </PopupSelect>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <SideInput value={viewport.width} label={t("browser.viewport.width")} onCommit={(width) => set({ ...viewport, width })} />
            <span className="text-[11px] text-gray-400 dark:text-white/30">×</span>
            <SideInput value={viewport.height} label={t("browser.viewport.height")} onCommit={(height) => set({ ...viewport, height })} />
          </div>
          <Tooltip content={t("browser.viewport.rotate")} placement="bottom">
            <Button variant="icon" onClick={() => set(rotate(viewport))} aria-label={t("browser.viewport.rotate")}
              className="cc-t flex items-center justify-center w-7 h-7 p-0 rounded-md shrink-0
                text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/10">
              <RotateIcon className="w-4 h-4" />
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
