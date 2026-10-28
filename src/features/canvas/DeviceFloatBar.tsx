import { useTranslation } from "react-i18next";

import { PopupSelect } from "@/shared/ui/PopupSelect";
import { DEVICES, DEVICE_BAR_H, DEVICE_SCALE, type DeviceSpec } from "@/features/browser/devices";

/**
 * A barra que flutua acima do "celular solto": o modelo do aparelho, diminuir e aumentar, voltar para a janela do
 * navegador e fechar. Ela também é a alça de arrastar o nó (`ade-node-drag`); os controles não arrastam (`nodrag`).
 */
export function DeviceFloatBar({ device, scale, armed, onModel, onScale, onWindow, onClose }: {
  device: DeviceSpec;
  scale: number;
  /** O fechar pede confirmação: o primeiro clique arma. */
  armed: boolean;
  onModel: (id: string) => void;
  onScale: (direction: 1 | -1) => void;
  onWindow: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const icon = "w-[15px] h-[15px]";
  const button = "nodrag cc-t flex items-center justify-center h-7 min-w-7 px-1.5 rounded-full text-white/75 hover:text-white hover:bg-white/12 disabled:opacity-35 disabled:hover:bg-transparent";
  return (
    <div className="ade-node-drag flex shrink-0 items-start justify-center cursor-grab active:cursor-grabbing" style={{ height: DEVICE_BAR_H }}>
      <div className="flex items-center gap-0.5 h-9 pl-1.5 pr-1 rounded-full bg-[#1c1c1e]/92 backdrop-blur-md ring-1 ring-white/10
        shadow-[0_10px_30px_-10px_rgba(0,0,0,0.6)] ade-device-bar-in">
        <PopupSelect aria-label={t("canvas.device.model")} value={device.id} onChange={(event) => onModel(event.target.value)}
          className="nodrag h-7 max-w-40 rounded-full border-0 bg-white/8 pl-2.5 text-[11.5px] text-white">
          {DEVICES.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </PopupSelect>
        <span aria-hidden className="mx-1 h-4 w-px bg-white/12" />
        <button type="button" className={button} onClick={() => onScale(-1)} disabled={scale <= DEVICE_SCALE.min + 0.001}
          title={t("canvas.device.smaller")} aria-label={t("canvas.device.smaller")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" className={icon} aria-hidden><path d="M5 12h14" /></svg>
        </button>
        <span className="w-9 text-center font-mono text-[10.5px] tabular-nums text-white/55">{Math.round(scale * 100)}%</span>
        <button type="button" className={button} onClick={() => onScale(1)} disabled={scale >= DEVICE_SCALE.max - 0.001}
          title={t("canvas.device.bigger")} aria-label={t("canvas.device.bigger")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" className={icon} aria-hidden><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <span aria-hidden className="mx-1 h-4 w-px bg-white/12" />
        <button type="button" className={button} onClick={onWindow} title={t("canvas.device.window")} aria-label={t("canvas.device.window")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className={icon} aria-hidden>
            <rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M3 9h18" /><circle cx="6.2" cy="6.8" r=".6" fill="currentColor" /><circle cx="8.4" cy="6.8" r=".6" fill="currentColor" />
          </svg>
        </button>
        <button type="button" onClick={onClose} title={armed ? t("canvas.portalDeleteConfirm") : t("canvas.portalDelete")}
          aria-label={armed ? t("canvas.portalDeleteConfirm") : t("canvas.portalDelete")}
          className={armed
            ? "nodrag cc-t flex items-center h-7 px-2.5 rounded-full text-[11px] font-medium text-white bg-red-500 hover:bg-red-600"
            : `${button} hover:!text-red-300`}>
          {armed ? t("canvas.portalDeleteConfirm") : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" className={icon} aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
          )}
        </button>
      </div>
    </div>
  );
}

/** O botão da barra da janela que solta o celular. */
export function PhoneModeIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.6" /><path d="M10.5 5h3" />
    </svg>
  );
}
