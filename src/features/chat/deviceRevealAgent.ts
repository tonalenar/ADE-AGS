import { readBrowserPreferences } from "@/features/browser/browserPreferences";

import { conversationOnScreen } from "./conversationOnScreen";
import { planDeviceReveal, type DeviceReveal } from "./deviceReveal";
import { addSurface, openDeviceFloat, setPanelDevice, useChatStore, type DeviceKind } from "./store";

/**
 * Mostra o aparelho que um agente acabou de abrir (`ags device create`): ele passa a ser o do painel e, conforme a
 * preferência "Auto-show floating preview" e a flag do agente, flutua sobre a conversa ou abre a aba do painel.
 * `near` é a aba do agente, a mesma que pediu o aparelho. Efeito sobre a store; a decisão está em `planDeviceReveal`.
 */
export function revealAgentDevice(input: {
  readonly near: string;
  readonly kind: DeviceKind;
  /** O UDID do simulador. Android não tem id até o `adb` listar o emulador: o painel escolhe o primeiro pronto. */
  readonly id: string | null;
  readonly name: string | null;
  readonly reveal: DeviceReveal;
}): void {
  if (input.id) setPanelDevice(input.kind, input.id, input.name);
  const plan = planDeviceReveal({
    reveal: input.reveal,
    autoShowFloatingPreview: readBrowserPreferences().autoShowFloatingPreview,
    conversationOnScreen: conversationOnScreen(input.near),
    panelShowsKind: useChatStore.getState().panel === input.kind,
  });
  if (plan === "float") openDeviceFloat(input.kind);
  else if (plan === "panel") addSurface(input.kind);
}
