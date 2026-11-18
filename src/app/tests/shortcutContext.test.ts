/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/chat/store", () => ({ useChatStore: { getState: () => ({ thread: null, panel: null, composing: false }) } }));
vi.mock("@/features/chat/structured/store", () => ({ useStructured: { getState: () => ({ live: {} }) } }));
vi.mock("@/features/tabs/store", () => ({ useTabsStore: { getState: () => ({ activeTabId: null }) } }));
vi.mock("@/app/uiStore", () => ({ useUiStore: { getState: () => ({ chatMode: false, shellMode: "workspace", drawer: null, paletteOpen: false, settingsSection: null }) } }));
vi.mock("@/features/terminal/structuredState", () => ({ structuredOf: () => null }));
vi.mock("@/features/chat/timeline/findModel", () => ({ activeTimelineConversationKey: () => null }));
vi.mock("@/features/browser/commands", () => ({ activePreviewViewId: () => null }));
vi.mock("@/features/chat/composerCommands", () => ({
  activeComposerCommandTarget: () => null,
  isAgentModelPickerOpen: () => false,
  isComposerCommandAvailable: () => false,
  isDesktopSnapshotTargetMounted: () => false,
  isFilePickerTargetMounted: () => false,
  isPromptStashTargetMounted: () => false,
}));
vi.mock("@/features/forge/pullRequestCommands", () => ({ isPullRequestCopyAvailable: () => false }));
vi.mock("@/features/chat/selectedConversationCommands", () => ({ selectedConversationPinTarget: () => null }));
vi.mock("@/features/chat/chatSpaces", () => ({ isFullscreenRoute: () => false }));
vi.mock("@/features/tabs/layout/layoutStore", () => ({ currentLayout: () => null }));
vi.mock("@/features/tabs/layout/layoutTree", () => ({ findGroup: () => undefined }));
vi.mock("@/features/tabs/workspaceCommands", () => ({ canOpenWorkspaceAgent: () => false }));
vi.mock("@/features/chat/terminalCommands", () => ({ canToggleChatTerminal: () => false }));

import { shortcutContext } from "../shortcutContext";

describe("shortcutContext terminalOpen", () => {
  it("ignora terminal montada mas oculta", () => {
    document.body.innerHTML = `
      <div data-terminal-tab="hidden" style="visibility: hidden">oculta</div>
      <div data-terminal-tab="shown">visível</div>
    `;
    expect(shortcutContext("/workspace").terminalOpen).toBe(true);
    document.body.innerHTML = `<div data-terminal-tab="hidden" style="visibility: hidden">oculta</div>`;
    expect(shortcutContext("/workspace").terminalOpen).toBe(false);
  });
});
