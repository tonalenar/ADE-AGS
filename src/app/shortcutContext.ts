import { useChatStore } from "@/features/chat/store";
import { useStructured } from "@/features/chat/structured/store";
import { useTabsStore } from "@/features/tabs/store";
import { structuredOf } from "@/features/terminal/structuredState";
import { useUiStore } from "@/app/uiStore";
import { activeTimelineConversationKey } from "@/features/chat/timeline/findModel";
import { activePreviewViewId } from "@/features/browser/commands";
import { activeComposerCommandTarget, isAgentModelPickerOpen, isComposerCommandAvailable, isDesktopSnapshotTargetMounted, isFilePickerTargetMounted, isPromptStashTargetMounted } from "@/features/chat/composerCommands";
import { isPullRequestCopyAvailable } from "@/features/forge/pullRequestCommands";
import { selectedConversationPinTarget } from "@/features/chat/selectedConversationCommands";
import { isFullscreenRoute } from "@/features/chat/chatSpaces";
import { currentLayout } from "@/features/tabs/layout/layoutStore";
import { findGroup } from "@/features/tabs/layout/layoutTree";
import { canOpenWorkspaceAgent } from "@/features/tabs/workspaceCommands";
import { canToggleChatTerminal } from "@/features/chat/terminalCommands";
import type { ShortcutWhenValues } from "./shortcutWhen";

function visible(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
    current = current.parentElement;
  }
  return element.getClientRects().length > 0;
}

/** Lê apenas o contexto da janela atual; não pesquisa nem altera o conteúdo do terminal. */
export function shortcutContext(pathname: string): ShortcutWhenValues {
  const hasDom = typeof document !== "undefined" && typeof window !== "undefined";
  const active = hasDom ? document.activeElement : null;
  const composer = hasDom ? document.querySelector<HTMLTextAreaElement>("[data-chat-composer]") : null;
  const composerTarget = activeComposerCommandTarget();
  const tabState = useTabsStore.getState();
  const chatState = useChatStore.getState();
  const uiState = useUiStore.getState();
  const selectedThread = chatState.thread;
  const threadWorking = selectedThread
    ? useStructured.getState().live[selectedThread]?.phase === "working"
    : false;
  const selectedTabWorking = tabState.activeTabId
    ? structuredOf(tabState.activeTabId)?.phase === "working"
    : false;
  const layout = currentLayout();
  const focusedGroup = layout ? findGroup(layout, layout.focused) : undefined;
  const inChatShell = uiState.chatMode && uiState.shellMode === "chat";
  const inWorkspaceShell = !inChatShell;
  const turnRunning = inChatShell ? threadWorking : selectedTabWorking;
  const editableFocus = !!active?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
  const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  return {
    terminalFocus: !!active?.closest("[data-terminal-tab]"),
    terminalOpen: hasDom
      && Array.from(document.querySelectorAll("[data-terminal-tab]")).some(visible),
    terminalSplitAvailable: !!focusedGroup?.active?.startsWith("a:"),
    terminalToggleAvailable: canToggleChatTerminal(pathname),
    workspaceAgentAvailable: canOpenWorkspaceAgent(pathname),
    previewFocus: !!active?.closest("[data-browser-column]"),
    diffFocus: !!active?.closest("[data-ade-diff-search-root]"),
    previewOpen: !!activePreviewViewId(),
    rightPanelOpen: inChatShell && chatState.panel !== null,
    chatShell: inChatShell && !isFullscreenRoute(pathname),
    workspaceShell: inWorkspaceShell,
    projectSearchOpen: uiState.drawer === "search",
    filePickerAvailable: inChatShell && isFilePickerTargetMounted(composerTarget),
    promptStashAvailable: inChatShell && isPromptStashTargetMounted(composerTarget),
    snapshotAvailable: inChatShell && isDesktopSnapshotTargetMounted(composerTarget),
    composerAlternateAvailable: inChatShell && isComposerCommandAvailable(composerTarget, "sendAlternate"),
    composerBackgroundAvailable: inChatShell && isComposerCommandAvailable(composerTarget, "sendBackground"),
    composerSendAndNewThreadAvailable: inChatShell && isComposerCommandAvailable(composerTarget, "sendAndNewThread"),
    conversationTimelineOpen: activeTimelineConversationKey() !== null,
    commandPaletteOpen: uiState.paletteOpen,
    modelPickerOpen: hasDom && isAgentModelPickerOpen(composerTarget),
    threadPinAvailable: inChatShell && !isFullscreenRoute(pathname) && selectedConversationPinTarget() !== null,
    pullRequestOpen: hasDom && isPullRequestCopyAvailable(),
    usagePageOpen: pathname.startsWith("/settings") && uiState.settingsSection === "accounts",
    composerFocus: active?.matches("[data-chat-composer]") ?? false,
    composerDraft: !!composer?.value.trim(),
    draftThreadRoute: inChatShell && chatState.composing,
    turnRunning,
    editableFocus,
    isWeb: !isDesktop,
    isDesktop,
  };
}
