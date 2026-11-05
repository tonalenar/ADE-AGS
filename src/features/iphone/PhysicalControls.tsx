import { useTranslation } from "react-i18next";

import { AlertaToast } from "@/shared/ui/alerts";

import type { Tone } from "./ConnectHint";
import { iphoneButton, iphoneGesture } from "./ipc";
import { HARDWARE_BUTTONS, SIDE_BUTTONS, SYSTEM_GESTURES, type HardwareButton, type SystemGesture } from "./model";

/** Manda um botão ou gesto ao aparelho. É a pessoa mexendo: não pede confirmação; o erro vira aviso. */
export function useDeviceActions(device: string, name: string) {
  const { t } = useTranslation();
  const fail = (e: unknown) => { void AlertaToast(name, String(e), "error", 5000); };
  return {
    home: () => { iphoneGesture(device, "home").catch(fail); },
    gesture: (g: SystemGesture) => { iphoneGesture(device, g).catch(fail); },
    button: (b: HardwareButton) => { iphoneButton(device, b).catch(fail); },
    label: {
      gesture: (g: SystemGesture) => t(`iphone.gesture.${g}`),
      button: (b: HardwareButton) => t(`iphone.button.${b}`),
    },
  };
}

const MENU: Record<Tone, { title: string; item: string; rule: string }> = {
  dark: {
    title: "px-2.5 pb-1 pt-1.5 text-[11px] text-white/55",
    item: "cc-t flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-white/90 hover:bg-white/8 disabled:opacity-40",
    rule: "mx-1.5 my-1 h-px bg-white/8",
  },
  panel: {
    title: "px-2 pt-1 pb-1.5 text-chat-caption font-medium text-gray-500 dark:text-white/50",
    item: "w-full h-8 px-2 rounded-md flex items-center gap-2 text-left text-gray-800 dark:text-white/85 hover:bg-gray-100 dark:hover:bg-white/[0.07] disabled:opacity-40",
    rule: "my-1 h-px bg-gray-200 dark:bg-white/[0.08]",
  },
};

/** O "⋯" do aparelho físico: Sistema (Central de Controle, de Notificações, Busca) e Botões (volume, mudo, Siri,
 *  bloquear). `ready` = o toque está pronto (sem ele os itens ficam apagados). */
export function PhysicalMenu({ device, name, tone, ready, onDone }: { device: string; name: string; tone: Tone; ready: boolean; onDone: () => void }) {
  const { t } = useTranslation();
  const act = useDeviceActions(device, name);
  const c = MENU[tone];
  return (
    <div className="flex flex-col">
      <div className={c.title}>{t("iphone.system")}</div>
      {SYSTEM_GESTURES.map((g) => (
        <button key={g} type="button" role="menuitem" disabled={!ready} onClick={() => { act.gesture(g); onDone(); }} className={c.item}>{act.label.gesture(g)}</button>
      ))}
      <div className={c.rule} />
      <div className={c.title}>{t("iphone.buttons")}</div>
      {HARDWARE_BUTTONS.map((b) => (
        <button key={b} type="button" role="menuitem" disabled={!ready} onClick={() => { act.button(b); onDone(); }} className={c.item}>{act.label.button(b)}</button>
      ))}
      {!ready && <p className="m-0 px-2.5 py-1.5 text-[11px] leading-snug opacity-60">{t("iphone.notReady")}</p>}
    </div>
  );
}

/**
 * Os botões físicos na lateral da moldura do iPhone (ação e volume à esquerda, lateral à direita), com o nome ao
 * passar o mouse, como no aparelho. `height` = a altura do aparelho em px.
 */
export function SideButtons({ device, name, height, ready }: { device: string; name: string; height: number; ready: boolean }) {
  const act = useDeviceActions(device, name);
  return (
    <>
      {SIDE_BUTTONS.map((b) => (
        <button key={b.button} type="button" disabled={!ready} title={act.label.button(b.button)} aria-label={act.label.button(b.button)}
          onClick={() => act.button(b.button)}
          className={`nodrag absolute w-[5px] rounded-sm bg-surface-overlay ring-1 ring-black/60 hover:bg-accent-500 disabled:opacity-50 disabled:hover:bg-surface-overlay ${b.side === "left" ? "-left-[4px]" : "-right-[4px]"}`}
          style={{ top: Math.round(b.top * height), height: Math.max(10, Math.round(b.height * height)) }} />
      ))}
    </>
  );
}
