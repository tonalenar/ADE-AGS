import { useChatStore } from "./store";
import { useTabsStore } from "@/features/tabs/store";

export const FILE_PICKER_COMMAND_EVENT = "ade:file-picker-toggle";
export const COMPOSER_COMMAND_EVENT = "ade:composer-command";

export type ComposerCommand = "sendAlternate" | "sendBackground" | "sendAndNewThread";

export interface ComposerCommandDetail {
  target: string;
  command: ComposerCommand;
}

export interface FilePickerCommandDetail {
  target: string;
}

const COMPOSER_COMMAND_ATTRIBUTES: Record<ComposerCommand, string> = {
  sendAlternate: "data-chat-composer-send-alternate",
  sendBackground: "data-chat-composer-send-background",
  sendAndNewThread: "data-chat-composer-send-and-new-thread",
};

/** A mesma ref que o ChatShell transforma no `composerTarget` da conversa atual. */
export function activeComposerCommandTarget(): string | null {
  const chat = useChatStore.getState();
  if (chat.composing) return "new-conversation";
  const { activeTabId } = useTabsStore.getState();
  return chat.thread ? `thread:${chat.thread}` : activeTabId;
}

function visible(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
    current = current.parentElement;
  }
  return element.getClientRects().length > 0;
}

/** Confirma que o composer de destino existe e está visível antes de consumir um atalho. */
export function isFilePickerTargetMounted(target: string | null): boolean {
  if (!target || typeof document === "undefined" || typeof window === "undefined") return false;
  return Array.from(document.querySelectorAll<HTMLTextAreaElement>("[data-chat-composer-target]"))
    .some((composer) => composer.dataset.chatComposerTarget === target && !composer.disabled && visible(composer));
}

function composerCommandTarget(target: string | null, command: ComposerCommand): HTMLTextAreaElement | null {
  if (!target || typeof document === "undefined" || typeof window === "undefined") return null;
  const attribute = COMPOSER_COMMAND_ATTRIBUTES[command];
  for (const composer of document.querySelectorAll<HTMLTextAreaElement>("[data-chat-composer-target]")) {
    if (composer.dataset.chatComposerTarget !== target || composer.disabled || !visible(composer)) continue;
    if (composer.getAttribute(attribute) === "true") return composer;
  }
  return null;
}

/** O comando só existe quando o composer visível publica que aceita aquela ação. */
export function isComposerCommandAvailable(target: string | null, command: ComposerCommand): boolean {
  return composerCommandTarget(target, command) !== null;
}

/** Entrega a ação ao composer de destino e confirma que um listener ativo a recebeu. */
export function runComposerCommand(target: string | null, command: ComposerCommand): boolean {
  if (!composerCommandTarget(target, command)) return false;
  const event = new CustomEvent<ComposerCommandDetail>(COMPOSER_COMMAND_EVENT, {
    cancelable: true,
    detail: { target: target!, command },
  });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Pede ao composer da conversa visível que abra o seletor nativo de anexos. */
export function toggleFilePicker(target: string | null): boolean {
  if (!target || typeof window === "undefined") return false;
  window.dispatchEvent(new CustomEvent<FilePickerCommandDetail>(FILE_PICKER_COMMAND_EVENT, {
    detail: { target },
  }));
  return true;
}

function agentModelPickerButton(target: string | null): HTMLButtonElement | null {
  if (!target || typeof document === "undefined" || typeof window === "undefined") return null;
  for (const composer of document.querySelectorAll<HTMLTextAreaElement>("[data-chat-composer-target]")) {
    if (composer.dataset.chatComposerTarget !== target || composer.disabled || !visible(composer)) continue;
    const button = composer.closest("form")?.querySelector<HTMLButtonElement>("[data-chat-agent-model-picker]");
    if (button && !button.disabled && visible(button)) return button;
  }
  return null;
}

function promptStashButton(target: string | null): HTMLButtonElement | null {
  if (!target || typeof document === "undefined" || typeof window === "undefined") return null;
  for (const composer of document.querySelectorAll<HTMLTextAreaElement>("[data-chat-composer-target]")) {
    if (composer.dataset.chatComposerTarget !== target || composer.disabled || !visible(composer)) continue;
    const button = composer.closest("form")?.querySelector<HTMLButtonElement>("[data-chat-prompt-stash]");
    if (button && !button.disabled && visible(button)) return button;
  }
  return null;
}

/** Confirma que o stash pode agir no composer visível sem tocar em outro rascunho. */
export function isPromptStashTargetMounted(target: string | null): boolean {
  return promptStashButton(target) !== null;
}

/** Reutiliza a ação que já pertence ao composer selecionado. */
export function togglePromptStash(target: string | null): boolean {
  const button = promptStashButton(target);
  if (!button) return false;
  button.click();
  return true;
}

/** Rótulo contextual já traduzido pelo botão do composer. */
export function promptStashTargetLabel(target: string | null): string | null {
  return promptStashButton(target)?.getAttribute("aria-label") ?? null;
}

/** Confirma que o seletor de agente da conversa ativa está montado e visível. */
export function isAgentModelPickerTargetMounted(target: string | null): boolean {
  return agentModelPickerButton(target) !== null;
}

/** Lê o estado somente do seletor pertencente ao composer de destino. */
export function isAgentModelPickerOpen(target: string | null): boolean {
  return agentModelPickerButton(target)?.getAttribute("aria-expanded") === "true";
}

/** Reutiliza o botão do composer para abrir ou fechar o seletor de agente ativo. */
export function toggleAgentModelPicker(target: string | null): boolean {
  const button = agentModelPickerButton(target);
  if (!button) return false;
  button.click();
  return true;
}
