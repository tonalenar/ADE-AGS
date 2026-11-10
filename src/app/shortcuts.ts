/**
 * Atajos de teclado globales para moverse por la app.
 *
 * ## Por qué son globales de verdad
 *
 * El punto del atajo es salir de donde estás sin levantar las manos del teclado, y donde
 * más se está es adentro de una terminal. Así que el listener se registra en `window` con
 * `capture: true`: la fase de captura baja desde `window` hasta el elemento, o sea que
 * corre ANTES que el handler del textarea de xterm. Con `preventDefault` +
 * `stopPropagation` el atajo nunca llega al proceso del agente.
 *
 * ## O preço, dito explicitamente
 *
 * Um Ctrl+letra não é só um acorde: num terminal ele já significa algo. Ctrl+M É Enter
 * (CR) e Ctrl+H É Backspace no protocolo, e Ctrl+E (fim de linha), Ctrl+F (avançar) e
 * Ctrl+K (apagar até o fim) são a edição estilo emacs do readline. Capturá-los aqui os
 * apaga DENTRO das TUIs.
 *
 * Por isso as seções vão em Ctrl+Shift+letra, que o terminal não distingue de Ctrl+letra
 * para controle e que nenhuma TUI comum usa. Só a paleta fica em Ctrl+K: é o atajo que
 * todo mundo espera para ela, e quem precisa do kill-line tem Ctrl+Shift+P como
 * alternativa. A tabela de baixo continua sendo o único lugar
 * onde essa decisão vive.
 *
 * ## Ir y volver con la misma tecla
 *
 * Cada atajo de sección es un interruptor: si ya estás en esa sección, te devuelve a la
 * terminal. Sin eso los atajos serían de ida nomás — rápido para irte de tu trabajo y un
 * click para volver, que es al revés de lo que hace falta.
 */

import { keyName } from "@/shared/keyboard";
import { DESKTOP_OS } from "@/app/platform";
import { shortcutBindingKey, useShortcutPreferences, type ShortcutBinding } from "./shortcutPrefs";
import { shortcutContext } from "./shortcutContext";
import { matchesShortcutWhen, shortcutWhensOverlap, validateShortcutWhen } from "./shortcutWhen";
import { activeProjectScriptCwd, projectScriptShortcutId } from "@/features/chat/projectScriptContext";
import { loadChatProjectScripts } from "@/features/chat/projectScripts";
import type { PreviewCommand } from "@/features/browser/commands";
import type { ComposerCommand } from "@/features/chat/composerCommands";

/** La ruta del área de terminales. Volver acá es volver a trabajar. */
export const WORKSPACE_PATH = "/workspace";

export type ShortcutAction =
  | { kind: "goto"; path: string }
  /** Configuración es un modal, no una ruta: se abre encima sin tapar las terminales. */
  | { kind: "openSettings" }
  /** A paleta de comandos: um modal, como Configurações. */
  | { kind: "openPalette" }
  /** `delta` en el ORDEN de la barra de tabs: +1 la siguiente, -1 la anterior. */
  | { kind: "cycleTab"; delta: 1 | -1 }
  /** O tamanho do texto dos terminais e do chat: +1 um passo maior, -1 menor, 0 de volta a 100 %. */
  | { kind: "textZoom"; delta: 1 | -1 | 0 }
  /** Alterna entre a casca do chat e o workspace (abas/canvas). Só com o modo chat ligado. */
  | { kind: "toggleChat" }
  /** Abre o painel Time e transfere o foco para ele, apenas no modo Chat. */
  | { kind: "openTeamPanel" }
  /** Volta ou avança no histórico de rotas da janela. */
  | { kind: "navigateHistory"; delta: -1 | 1 }
  /** Abre o rascunho de uma conversa nova no modo Chat. */
  | { kind: "newConversation" }
  /** Abre um rascunho no diretório da conversa ou aba ativa. */
  | { kind: "newConversationLocal" }
  /** Interrompe o turno ativo da conversa focada. */
  | { kind: "stopThread" }
  /** Desfaz a ação reversível mais recente da lista do chat. */
  | { kind: "undoThreadAction" }
  /** Fixa ou desafixa a conversa selecionada na barra do Chat. */
  | { kind: "togglePinnedConversation" }
  /** Abre uma conversa nova na pasta pessoal, sem projeto. */
  | { kind: "newConversationWithoutProject" }
  /** Mostra as superfícies disponíveis no painel direito. */
  | { kind: "newPanelSurface" }
  /** Alterna a visibilidade do painel direito do Chat. */
  | { kind: "toggleRightPanel" }
  /** Alterna a visibilidade da sidebar do Chat sem desmontar o conteúdo da conversa. */
  | { kind: "toggleChatSidebar" }
  /** Fecha o painel direito do Chat. */
  | { kind: "closeRightPanel" }
  /** Alterna o painel direito entre largura normal e maximizada. */
  | { kind: "toggleRightPanelMaximized" }
  /** Abre/fecha o navegador em foco, sem criar outra vista quando já existe. */
  | { kind: "toggleBrowserPreview" }
  /** Executa uma ação na instância visível do navegador identificada pelo viewId. */
  | { kind: "previewCommand"; command: PreviewCommand }
  /** Abre/fecha a busca textual no workspace ativo. */
  | { kind: "toggleProjectSearch" }
  /** Pede ao composer selecionado que abra o seletor nativo de anexos. */
  | { kind: "toggleFilePicker" }
  /** Aciona salvar/restaurar prompt stash no composer visível. */
  | { kind: "togglePromptStash" }
  /** Executa uma ação de envio no composer visível sem reconstruir seu rascunho. */
  | { kind: "composerCommand"; command: ComposerCommand }
  /** Abre ou fecha o seletor de agente do composer ativo. */
  | { kind: "toggleModelPicker" }
  /** Abre ou fecha a superfície Diff do painel do Chat. */
  | { kind: "toggleDiffPanel" }
  /** Percorre Sistema, Claro e Escuro sem alterar o tema personalizado ativo. */
  | { kind: "cycleAppearance" }
  /** Abre a seleção de tema ou alterna o editor de temas nas Configurações. */
  | { kind: "selectTheme" }
  | { kind: "toggleThemeEditor" }
  /** Abre a busca local na timeline da conversa visível. */
  | { kind: "findConversation" }
  /** Copia o número do pull request visível no Forge. */
  | { kind: "copyPullRequestNumber" }
  /** Inicia ou encerra o ditado no composer que está com foco. */
  | { kind: "toggleDictation" }
  /** Captura o display principal e anexa ao composer visível, pelo mesmo botão de câmera. */
  | { kind: "takeSnapshot" }
  /** Abre a conversa na posição visível da sidebar, como no T3 Code. */
  | { kind: "quickThread"; index: number }
  /** Traz à frente o workspace aberto seguinte/anterior, sem criar nem fechar janelas. */
  | { kind: "focusOpenWorkspace"; delta: 1 | -1 }
  /** Divide a tela do workspace sem duplicar ou encerrar a sessão do agente. */
  | { kind: "splitWorkspaceTerminal"; side: "right" | "down" }
  /** Alterna a gaveta ou o shell lateral da conversa selecionada no Chat. */
  | { kind: "toggleChatTerminal" }
  /** Abre o assistente existente para iniciar uma nova sessão no workspace ativo. */
  | { kind: "newWorkspaceAgent" }
  /** Seleciona a opção do catálogo na posição exibida pelo seletor de modelos. */
  | { kind: "quickModel"; index: number }
  /** Executa um dos primeiros resultados da paleta aberta. */
  | { kind: "quickPalette"; index: number }
  | { kind: "runProjectScript"; cwd: string; scriptId: string; name: string };

export interface Shortcut {
  /** Identificador estável para preferências locais. */
  id: string;
  /** A ação original quando `id` identifica uma regra contextual adicional. */
  actionId?: string;
  /** Id estável da regra contextual adicional. */
  ruleId?: string;
  /** `KeyboardEvent.key` en minúscula. */
  key: string;
  ctrl?: boolean;
  /** `true` exige Shift; ausente exige que NO esté. */
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  action: ShortcutAction;
  /** La ruta con la que se busca este acorde desde un botón (ver `shortcutForPath`).
   *  Se declara aparte porque no toda acción es una navegación: configuración abre un
   *  modal, pero el botón que lo abre sigue queriendo mostrar "Ctrl+G". */
  path?: string;
  /** Cómo se escribe para el usuario. No se traduce: "Ctrl" se llama igual en los dos idiomas. */
  display: string;
  /** Clave i18n de qué hace. */
  labelKey: string;
  /** Nombre de una acción dinámica de proyecto, presentado con `labelKey`. */
  labelName?: string;
  /** Proyecto de la acción dinámica, presentado con `labelKey`. */
  labelProject?: string;
  /** Condición opcional que limita el acorde al estado actual de la interfaz. */
  when?: string;
  enabled?: boolean;
}

/**
 * Las letras siguen la inicial en español —**H**ome, s**E**siones, s**K**ills,
 * **M**arketplace, **F**lota, confi**G**uración— salvo skills, que empieza igual que
 * sesiones. Ctrl+F se le saca a la terminal (en readline es "avanzar un carácter"), el
 * mismo precio que ya pagan Ctrl+E y Ctrl+K, y bastante menos grave que lo que se evitó
 * con Ctrl+W y Ctrl+S.
 *
 * Workspaces queda a propósito sin atajo: las teclas que le tocarían (Ctrl+W cierra,
 * Ctrl+S congela la terminal con XOFF) hacen más daño que bien, y se llega desde Home.
 */
export const SHORTCUTS: Shortcut[] = [
  { id: "palette.primary", key: "k", action: { kind: "openPalette" }, display: "Ctrl+K", labelKey: "palette.open" },
  { id: "palette.alternate", key: "p", shift: true, action: { kind: "openPalette" }, display: "Ctrl+Shift+P", labelKey: "palette.open" },
  { id: "navigation.home", key: "h", shift: true, action: { kind: "goto", path: "/" }, display: "Ctrl+Shift+H", labelKey: "sidebar.home" },
  { id: "navigation.sessions", key: "e", shift: true, action: { kind: "goto", path: "/sessions" }, display: "Ctrl+Shift+E", labelKey: "sidebar.sessions" },
  { id: "navigation.skills", key: "s", shift: true, action: { kind: "goto", path: "/skills" }, display: "Ctrl+Shift+S", labelKey: "sidebar.skills" },
  { id: "navigation.marketplace", key: "m", shift: true, action: { kind: "goto", path: "/marketplace" }, display: "Ctrl+Shift+M", labelKey: "sidebar.marketplace" },
  { id: "navigation.fleet", key: "f", shift: true, action: { kind: "goto", path: "/fleet" }, display: "Ctrl+Shift+F", labelKey: "sidebar.fleet" },
  { id: "settings.open", key: ",", action: { kind: "openSettings" }, path: "/settings", display: "Ctrl+,", labelKey: "sidebar.settings" },
  { id: "navigation.back", key: "[", ctrl: DESKTOP_OS !== "macos", meta: DESKTOP_OS === "macos", action: { kind: "navigateHistory", delta: -1 }, when: "!terminalFocus && !previewFocus && !editableFocus", display: DESKTOP_OS === "macos" ? "Cmd+[" : "Ctrl+[", labelKey: "shortcuts.historyBack" },
  { id: "navigation.forward", key: "]", ctrl: DESKTOP_OS !== "macos", meta: DESKTOP_OS === "macos", action: { kind: "navigateHistory", delta: 1 }, when: "!terminalFocus && !previewFocus && !editableFocus", display: DESKTOP_OS === "macos" ? "Cmd+]" : "Ctrl+]", labelKey: "shortcuts.historyForward" },
  { id: "chat.find", key: "f", ctrl: DESKTOP_OS !== "macos", meta: DESKTOP_OS === "macos", action: { kind: "findConversation" }, when: "(conversationTimelineOpen || diffFocus) && !terminalFocus && !previewFocus && !modelPickerOpen && !commandPaletteOpen", display: DESKTOP_OS === "macos" ? "Cmd+F" : "Ctrl+F", labelKey: "shortcuts.chatFind" },
  ...Array.from({ length: 9 }, (_, index) => ({
    id: `chat.quickThread.${index + 1}`,
    key: String(index + 1),
    ctrl: DESKTOP_OS !== "macos",
    meta: DESKTOP_OS === "macos",
    action: { kind: "quickThread", index: index + 1 } as const,
    when: "isDesktop && !terminalFocus && !previewFocus && !modelPickerOpen && !commandPaletteOpen",
    display: `${DESKTOP_OS === "macos" ? "Cmd" : "Ctrl"}+${index + 1}`,
    labelKey: `shortcuts.quickThread${index + 1}`,
  })),
  ...Array.from({ length: 9 }, (_, index) => ({
    id: `chat.quickModel.${index + 1}`,
    key: String(index + 1),
    ctrl: DESKTOP_OS !== "macos",
    meta: DESKTOP_OS === "macos",
    action: { kind: "quickModel", index: index + 1 } as const,
    when: "isDesktop && modelPickerOpen && !commandPaletteOpen",
    display: `${DESKTOP_OS === "macos" ? "Cmd" : "Ctrl"}+${index + 1}`,
    labelKey: `shortcuts.quickModel${index + 1}`,
  })),
  ...Array.from({ length: 9 }, (_, index) => ({
    id: `palette.quickResult.${index + 1}`,
    key: String(index + 1),
    ctrl: DESKTOP_OS !== "macos",
    meta: DESKTOP_OS === "macos",
    action: { kind: "quickPalette", index: index + 1 } as const,
    when: "isDesktop && commandPaletteOpen",
    display: `${DESKTOP_OS === "macos" ? "Cmd" : "Ctrl"}+${index + 1}`,
    labelKey: `shortcuts.quickPalette${index + 1}`,
  })),
  {
    id: "composer.dictation",
    key: "d",
    ctrl: DESKTOP_OS !== "macos",
    meta: DESKTOP_OS === "macos",
    shift: true,
    action: { kind: "toggleDictation" } as const,
    when: "composerFocus && isDesktop",
    display: DESKTOP_OS === "macos" ? "Cmd+Shift+D" : "Ctrl+Shift+D",
    labelKey: "shortcuts.dictation",
  },
  ...(DESKTOP_OS === "macos" ? [{ id: "composer.snapshot", key: "s", ctrl: false, meta: true, shift: true, action: { kind: "takeSnapshot" } as const, when: "chatShell && snapshotAvailable && isDesktop && !terminalFocus && !previewFocus && !commandPaletteOpen", display: "Cmd+Shift+S", labelKey: "shortcuts.composerSnapshot" }] : []),
  { id: "rightPanel.new", key: "t", ctrl: DESKTOP_OS !== "macos", meta: DESKTOP_OS === "macos", action: { kind: "newPanelSurface" }, when: "rightPanelOpen && !terminalFocus && !previewFocus && !modelPickerOpen && !commandPaletteOpen && isDesktop", display: DESKTOP_OS === "macos" ? "Cmd+T" : "Ctrl+T", labelKey: "shortcuts.panelNewSurface" },
  { id: "sidebar.toggle", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "toggleChatSidebar" }, when: "chatShell && !terminalFocus && !previewFocus && !editableFocus && !modelPickerOpen && !commandPaletteOpen && isDesktop", display: "", labelKey: "shortcuts.toggleChatSidebar" },
  { id: "rightPanel.toggle", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "toggleRightPanel" }, when: "!terminalFocus && !previewFocus && !editableFocus && !modelPickerOpen && !commandPaletteOpen && isDesktop", display: "", labelKey: "shortcuts.toggleRightPanel" },
  { id: "rightPanel.close", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "closeRightPanel" }, when: "rightPanelOpen && !terminalFocus && !previewFocus && !editableFocus && !modelPickerOpen && !commandPaletteOpen && isDesktop", display: "", labelKey: "shortcuts.closeRightPanel" },
  { id: "rightPanel.toggleMaximized", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "toggleRightPanelMaximized" }, when: "rightPanelOpen && !terminalFocus && !previewFocus && !editableFocus && !modelPickerOpen && !commandPaletteOpen && isDesktop", display: "", labelKey: "shortcuts.toggleRightPanelMaximized" },
  { id: "preview.toggle", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "toggleBrowserPreview" }, when: "!terminalFocus && !previewFocus && !editableFocus && !modelPickerOpen && !commandPaletteOpen && isDesktop", display: "", labelKey: "shortcuts.previewToggle" },
  { id: "preview.refresh", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "previewCommand", command: "refresh" }, when: "previewOpen && !terminalFocus && !editableFocus && !modelPickerOpen && !commandPaletteOpen && isDesktop", display: "", labelKey: "shortcuts.previewRefresh" },
  { id: "preview.focusUrl", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "previewCommand", command: "focusUrl" }, when: "previewOpen && !terminalFocus && !editableFocus && !modelPickerOpen && !commandPaletteOpen && isDesktop", display: "", labelKey: "shortcuts.previewFocusUrl" },
  { id: "preview.zoomIn", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "previewCommand", command: "zoomIn" }, when: "previewOpen && !terminalFocus && !editableFocus && !modelPickerOpen && !commandPaletteOpen && isDesktop", display: "", labelKey: "shortcuts.previewZoomIn" },
  { id: "preview.zoomOut", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "previewCommand", command: "zoomOut" }, when: "previewOpen && !terminalFocus && !editableFocus && !modelPickerOpen && !commandPaletteOpen && isDesktop", display: "", labelKey: "shortcuts.previewZoomOut" },
  { id: "preview.resetZoom", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "previewCommand", command: "resetZoom" }, when: "previewOpen && !terminalFocus && !editableFocus && !modelPickerOpen && !commandPaletteOpen && isDesktop", display: "", labelKey: "shortcuts.previewResetZoom" },
  { id: "projectSearch.toggle", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "toggleProjectSearch" }, when: "isDesktop && workspaceShell && (!editableFocus || projectSearchOpen) && !terminalFocus && !commandPaletteOpen", display: "", labelKey: "shortcuts.projectSearchToggle" },
  { id: "filePicker.toggle", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "toggleFilePicker" }, when: "isDesktop && filePickerAvailable && (composerFocus || !editableFocus) && !terminalFocus && !commandPaletteOpen", display: "", labelKey: "shortcuts.filePickerToggle" },
  { id: "composer.stash", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "togglePromptStash" }, when: "chatShell && promptStashAvailable && composerFocus && !terminalFocus && !previewFocus && !commandPaletteOpen && isDesktop", display: "", labelKey: "shortcuts.composerStash" },
  { id: "composer.sendAlternate", key: "enter", ctrl: DESKTOP_OS !== "macos", meta: DESKTOP_OS === "macos", action: { kind: "composerCommand", command: "sendAlternate" }, when: "chatShell && composerAlternateAvailable && composerFocus && !terminalFocus && !previewFocus && !commandPaletteOpen", display: DESKTOP_OS === "macos" ? "Cmd+Enter" : "Ctrl+Enter", labelKey: "shortcuts.composerSendAlternate" },
  { id: "composer.sendBackground", key: "enter", ctrl: DESKTOP_OS !== "macos", meta: DESKTOP_OS === "macos", action: { kind: "composerCommand", command: "sendBackground" }, when: "chatShell && composerBackgroundAvailable && !composerAlternateAvailable && composerFocus && !terminalFocus && !previewFocus && !commandPaletteOpen", display: DESKTOP_OS === "macos" ? "Cmd+Enter" : "Ctrl+Enter", labelKey: "shortcuts.composerSendBackground" },
  { id: "composer.sendAndNewThread", key: DESKTOP_OS === "macos" ? "enter" : "", ctrl: false, meta: DESKTOP_OS === "macos", alt: DESKTOP_OS === "macos", shift: false, action: { kind: "composerCommand", command: "sendAndNewThread" }, when: "chatShell && composerSendAndNewThreadAvailable && composerFocus && !terminalFocus && !previewFocus && !commandPaletteOpen && isDesktop", display: DESKTOP_OS === "macos" ? "Cmd+Option+Enter" : "", labelKey: "shortcuts.composerSendAndNewThread" },
  { id: "modelPicker.toggle", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "toggleModelPicker" }, when: "chatShell && (composerFocus || modelPickerOpen) && !terminalFocus && !previewFocus && !commandPaletteOpen && isDesktop", display: "", labelKey: "shortcuts.modelPickerToggle" },
  { id: "diff.toggle", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "toggleDiffPanel" }, when: "chatShell && !terminalFocus && !previewFocus && !editableFocus && !modelPickerOpen && !commandPaletteOpen && isDesktop", display: "", labelKey: "shortcuts.diffToggle" },
  { id: "pullRequest.copyNumber", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "copyPullRequestNumber" }, when: "pullRequestOpen && !terminalFocus && !previewFocus && !editableFocus && !modelPickerOpen && !commandPaletteOpen && isDesktop", display: "", labelKey: "forge.pr.copyNumber" },
  { id: "theme.select", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "selectTheme" }, when: "isDesktop && !terminalFocus && !previewFocus && !modelPickerOpen && !commandPaletteOpen", display: "", labelKey: "shortcuts.themeSelect" },
  { id: "appearance.cycle", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "cycleAppearance" }, when: "isDesktop && !terminalFocus && !editableFocus && !modelPickerOpen && !commandPaletteOpen", display: "", labelKey: "shortcuts.appearanceCycle" },
  { id: "themeEditor.toggle", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "toggleThemeEditor" }, when: "isDesktop && !terminalFocus && !previewFocus && !modelPickerOpen && !commandPaletteOpen", display: "", labelKey: "shortcuts.themeEditorToggle" },
  { id: "chat.new", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "newConversation" }, display: "", labelKey: "chat.new.title" },
  { id: "chat.newLocal", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "newConversationLocal" }, display: "", labelKey: "shortcuts.chatNewLocal" },
  { id: "chat.newWithoutProject", key: "n", ctrl: DESKTOP_OS !== "macos", shift: DESKTOP_OS !== "macos", alt: DESKTOP_OS === "macos", meta: DESKTOP_OS === "macos", action: { kind: "newConversationWithoutProject" }, display: DESKTOP_OS === "macos" ? "⌘+⌥+N" : "Ctrl+Shift+N", labelKey: "shortcuts.chatNewWithoutProject" },
  { id: "thread.stop", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "stopThread" }, display: "", labelKey: "shortcuts.threadStop" },
  { id: "thread.pin", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "togglePinnedConversation" }, when: "chatShell && threadPinAvailable && !terminalFocus && !previewFocus && !editableFocus && !modelPickerOpen && !commandPaletteOpen && isDesktop", display: "", labelKey: "shortcuts.threadPin" },
  { id: "thread.undo", key: "z", ctrl: DESKTOP_OS !== "macos", meta: DESKTOP_OS === "macos", action: { kind: "undoThreadAction" }, display: DESKTOP_OS === "macos" ? "⌘+Z" : "Ctrl+Z", labelKey: "shortcuts.threadUndo" },
  { id: "tabs.next", key: "tab", action: { kind: "cycleTab", delta: 1 }, display: "Ctrl+Tab", labelKey: "shortcuts.nextTab" },
  {
    id: "tabs.previous",
    key: "tab",
    shift: true,
    action: { kind: "cycleTab", delta: -1 },
    display: "Ctrl+Shift+Tab",
    labelKey: "shortcuts.prevTab",
  },
  { id: "workspace.focusNext", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "focusOpenWorkspace", delta: 1 }, when: "isDesktop", display: "", labelKey: "shortcuts.workspaceFocusNext" },
  { id: "workspace.focusPrevious", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "focusOpenWorkspace", delta: -1 }, when: "isDesktop", display: "", labelKey: "shortcuts.workspaceFocusPrevious" },
  { id: "terminal.splitRight", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "splitWorkspaceTerminal", side: "right" }, when: "terminalSplitAvailable && workspaceShell && isDesktop && !previewFocus && !editableFocus && !commandPaletteOpen", display: "", labelKey: "shortcuts.terminalSplitRight" },
  { id: "terminal.splitDown", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "splitWorkspaceTerminal", side: "down" }, when: "terminalSplitAvailable && workspaceShell && isDesktop && !previewFocus && !editableFocus && !commandPaletteOpen", display: "", labelKey: "shortcuts.terminalSplitDown" },
  { id: "terminal.toggle", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "toggleChatTerminal" }, when: "terminalToggleAvailable && chatShell && !terminalFocus && !previewFocus && !editableFocus && !commandPaletteOpen && isDesktop", display: "", labelKey: "shortcuts.terminalToggle" },
  { id: "terminal.new", key: "", ctrl: false, shift: false, alt: false, meta: false, action: { kind: "newWorkspaceAgent" }, when: "workspaceAgentAvailable && isDesktop && !terminalFocus && !previewFocus && !editableFocus && !commandPaletteOpen", display: "", labelKey: "shortcuts.terminalNew" },
  // O zoom do texto: os acordes que todo app usa. Ctrl+- é o "desfazer" do readline, mas ele continua no Ctrl+_
  // (Ctrl+Shift+-), que é como se digita; Ctrl+= e Ctrl+0 não têm uso nas TUIs.
  { id: "zoom.in.equals", key: "=", action: { kind: "textZoom", delta: 1 }, display: "Ctrl+=", labelKey: "shortcuts.zoomIn" },
  { id: "zoom.in.shift-plus", key: "+", shift: true, action: { kind: "textZoom", delta: 1 }, display: "Ctrl++", labelKey: "shortcuts.zoomIn" },
  { id: "zoom.in.plus", key: "+", action: { kind: "textZoom", delta: 1 }, display: "Ctrl++", labelKey: "shortcuts.zoomIn" },
  { id: "zoom.out", key: "-", action: { kind: "textZoom", delta: -1 }, display: "Ctrl+-", labelKey: "shortcuts.zoomOut" },
  { id: "zoom.reset", key: "0", action: { kind: "textZoom", delta: 0 }, display: "Ctrl+0", labelKey: "shortcuts.zoomReset" },
  // Chat ⇄ abas/canvas. Sem Alt (AltGr, ver `matchShortcut`); com o modo chat desligado o acorde
  // segue para o terminal (ver `useGlobalShortcuts`).
  { id: "chat.toggle", key: "l", shift: true, action: { kind: "toggleChat" }, display: "Ctrl+Shift+L", labelKey: "chat.mode.toggle" },
  { id: "chat.teamPanel", key: DESKTOP_OS === "macos" ? "t" : "o", ctrl: DESKTOP_OS !== "macos", meta: DESKTOP_OS === "macos", alt: DESKTOP_OS === "macos", shift: DESKTOP_OS !== "macos", action: { kind: "openTeamPanel" }, display: DESKTOP_OS === "macos" ? "⌥+⌘+T" : "Ctrl+Shift+O", labelKey: "chat.team.shortcut" },
];

function keyDisplay(key: string): string {
  const names: Record<string, string> = {
    arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", escape: "Esc",
    space: "Space", pageup: "Page Up", pagedown: "Page Down", backspace: "Backspace",
  };
  return names[key] ?? (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
}

function formatBinding(binding: ShortcutBinding): string {
  const mods = [
    binding.meta ? (/Mac|iPhone|iPad/i.test(globalThis.navigator?.platform ?? "") ? "Cmd" : "Meta") : null,
    binding.ctrl ? "Ctrl" : null,
    binding.alt ? "Alt" : null,
    binding.shift ? "Shift" : null,
  ].filter((part): part is string => !!part);
  return [...mods, keyDisplay(binding.key)].join("+");
}

/** Atalhos efetivos, combinando defaults e preferências locais validadas. */
export function getShortcuts(projectContext?: { cwd: string | null; scripts: ReturnType<typeof loadChatProjectScripts> }): Shortcut[] {
  const { bindings: overrides, conditions, contextualRules } = useShortcutPreferences.getState();
  const resolved: Shortcut[] = [];
  for (const shortcut of SHORTCUTS) {
    if (Object.prototype.hasOwnProperty.call(overrides, shortcut.id) && overrides[shortcut.id] === null) {
      resolved.push({ ...shortcut, when: conditions[shortcut.id] ?? shortcut.when, key: "", ctrl: false, shift: false, alt: false, meta: false, display: "", enabled: false });
      continue;
    }
    const saved = overrides[shortcut.id];
    const binding = saved ?? {
      key: shortcut.key, ctrl: shortcut.ctrl ?? true, shift: Boolean(shortcut.shift), alt: Boolean(shortcut.alt), meta: Boolean(shortcut.meta),
    };
    // A condição editada nas Configurações vale; sem ela, vale a da tabela (sem isso o `when` padrão de
    // `chat.find`, `thread.undo`, Ctrl+1…9 etc. se perdia e o acorde roubava a tecla do terminal).
    const when = conditions[shortcut.id] ?? shortcut.when;
    const collides = (candidate: ShortcutBinding) => resolved.some((other) => other.enabled !== false
      && shortcutBindingKey(bindingOf(other)) === shortcutBindingKey(candidate)
      && shortcutWhensOverlap(other.when, when));
    // Se a preferência local colidir em contextos sobrepostos, mantém o default desta ação.
    const selected = saved && collides(binding)
      ? { key: shortcut.key, ctrl: shortcut.ctrl ?? true, shift: Boolean(shortcut.shift), alt: Boolean(shortcut.alt), meta: Boolean(shortcut.meta) }
      : binding;
    const stillCollides = collides(selected);
    const effective = saved && selected === binding
      ? { ...shortcut, ...binding, display: formatBinding(binding) }
      : shortcut;
    resolved.push({ ...effective, when, enabled: stillCollides ? false : effective.enabled });
  }

  // Ações de projeto são específicas do contexto ativo e não recebem atalho por padrão.
  // Os IDs persistidos são curtos e não expõem caminhos locais.
  const projectCwd = projectContext?.cwd ?? activeProjectScriptCwd();
  if (projectCwd) {
    const projectScripts = projectContext?.cwd === projectCwd ? projectContext.scripts : loadChatProjectScripts(projectCwd);
    for (const script of projectScripts) {
      const id = projectScriptShortcutId(projectCwd, script.id);
      const saved = overrides[id];
      const binding = saved ?? null;
      const collision = binding ? resolved.some((other) => other.enabled !== false
        && shortcutBindingKey(bindingOf(other)) === shortcutBindingKey(binding)
        && shortcutWhensOverlap(other.when, conditions[id])) : false;
      resolved.push({
        id,
        key: binding && !collision ? binding.key : "",
        ctrl: binding?.ctrl ?? false,
        shift: binding?.shift ?? false,
        alt: binding?.alt ?? false,
        meta: binding?.meta ?? false,
        action: { kind: "runProjectScript", cwd: projectCwd, scriptId: script.id, name: script.name },
        display: binding && !collision ? formatBinding(binding) : "",
        labelKey: "settings.shortcuts.projectScript",
        labelName: script.name,
        labelProject: projectCwd,
        when: conditions[id],
        enabled: Boolean(binding) && !collision,
      });
    }
  }

  const all = [...resolved];
  for (const base of resolved) {
    for (const rule of contextualRules[base.id] ?? []) {
      if (!rule.binding || !rule.when.trim() || !validateShortcutWhen(rule.when).ok) continue;
      const collides = all.some((other) => other.enabled !== false
        && shortcutBindingKey(bindingOf(other)) === shortcutBindingKey(rule.binding!)
        && shortcutWhensOverlap(other.when, rule.when));
      all.push({
        ...base,
        id: `${base.id}:context:${rule.id}`,
        actionId: base.id,
        ruleId: rule.id,
        ...rule.binding,
        when: rule.when,
        display: formatBinding(rule.binding),
        enabled: !collides,
      });
    }
  }
  return all;
}

function bindingOf(shortcut: Shortcut): ShortcutBinding {
  return {
    key: shortcut.key,
    ctrl: shortcut.ctrl ?? true,
    shift: Boolean(shortcut.shift),
    alt: Boolean(shortcut.alt),
    meta: Boolean(shortcut.meta),
  };
}

export function shortcutForId(id: string): string | null {
  const shortcut = getShortcuts().find((candidate) => candidate.id === id);
  return shortcut?.enabled === false ? null : shortcut?.display ?? null;
}

/** Lo que hace falta de un `KeyboardEvent` — estructural para poder testear sin DOM. */
export interface KeyChord {
  key: string;
  /** La tecla física. Hace falta para reconocer Shift+Tab en WebKitGTK (ver `keyName`). */
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** Recupera a tecla física quando Option altera o caractere em acordes do macOS. */
export function shortcutKeyFromEvent(e: KeyChord): string {
  const rawKey = keyName(e);
  if (e.altKey && e.metaKey && !/^[a-z0-9]$/i.test(rawKey) && /^Key[a-z]$/i.test(e.code ?? "")) {
    return e.code!.slice(3).toLowerCase();
  }
  return rawKey === " " ? "space" : rawKey.toLowerCase();
}

export function matchShortcut(e: KeyChord, pathname = ""): Shortcut | null {
  // Alt tiene que estar ausente, y no es un detalle: en Windows y Linux AltGr llega como
  // Ctrl+Alt, así que sin esta condición escribir un carácter con AltGr dispararía atajos.
  // Meta queda afuera por lo mismo (Cmd+M minimiza en macOS).
  // Ctrl+Alt é AltGr em várias distribuições de teclado; nunca o interprete como acorde.
  if (e.ctrlKey && e.altKey) return null;
  const key = shortcutKeyFromEvent(e);
  const candidates = getShortcuts().filter((s) => s.key === key
    && s.enabled !== false
    && (s.ctrl ?? true) === e.ctrlKey
    && Boolean(s.shift) === e.shiftKey
    && Boolean(s.alt) === e.altKey
    && Boolean(s.meta) === e.metaKey);
  if (candidates.length === 0) return null;
  let context: ReturnType<typeof shortcutContext> | null = null;
  return candidates.find((shortcut) => {
    if (!shortcut.when?.trim()) return true;
    context ??= shortcutContext(pathname);
    return matchesShortcutWhen(shortcut.when, context);
  }) ?? null;
}

/**
 * A dónde lleva un atajo de sección. `null` = no hay nada que hacer.
 *
 * Estando ya en la sección devuelve a la terminal, pero solo si hay alguna tab: sin tabs
 * `/workspace` rebota a Home solo (ver `AppShell`), así que el atajo haría parpadear la
 * vista para terminar donde ya estaba.
 */
export function resolveGoto(target: string, currentPath: string, hasTabs: boolean): string | null {
  // `/skills/<id>` é a seção Skills: o atalho de Skills nessa página também deve voltar à terminal.
  const inSection = currentPath === target || currentPath.startsWith(`${target}/`);
  if (!inSection) return target;
  return hasTabs ? WORKSPACE_PATH : null;
}

/**
 * La tab a activar al ciclar. Da la vuelta en los dos extremos: llegar a la última y
 * quedarse trabado ahí obliga a hacer el camino de vuelta tecla por tecla.
 */
export function nextTabId(tabIds: string[], activeId: string | null, delta: number): string | null {
  if (tabIds.length === 0) return null;
  const current = activeId === null ? -1 : tabIds.indexOf(activeId);
  // Sin tab activa se entra por la punta que corresponde al sentido del ciclo.
  if (current === -1) return delta > 0 ? tabIds[0] : tabIds[tabIds.length - 1];
  return tabIds[(current + delta + tabIds.length) % tabIds.length];
}

/** El acorde que lleva a esta ruta, para mostrarlo en el tooltip del botón que hace lo mismo. */
export function shortcutForPath(path: string): string | null {
  const found = getShortcuts().find(
    (s) => s.enabled !== false && (s.path === path || (s.action.kind === "goto" && s.action.path === path))
  );
  return found?.display ?? null;
}

/** O atalho principal da paleta, atualizado quando a pessoa altera a combinação. */
export function paletteShortcutLabel(): string {
  return shortcutForId("palette.primary") ?? "—";
}
