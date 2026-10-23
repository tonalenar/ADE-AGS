/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({
  tabs: [] as Array<{ id: string; title: string; agentId: string; agentLabel: string; cwd: string }>,
  activateTab: vi.fn(),
  setJump: vi.fn(),
  insertIntoTab: vi.fn(),
  focusTab: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k) }),
}));
vi.mock("@/features/tabs/store", () => ({ useTabsStore: { getState: () => ({ tabs: m.tabs, activateTab: m.activateTab }) } }));
vi.mock("@/features/tabs/viewStore", () => ({ useViewTabsStore: { getState: () => ({ showTerminal: () => undefined }) } }));
vi.mock("@/features/canvas/chatUnread", () => ({ useUnreadStore: { getState: () => ({ setJump: m.setJump }) } }));
vi.mock("@/features/canvas/store", () => ({
  boardKeyOfTab: () => "k",
  useCanvasStore: { getState: () => ({ boards: {}, modes: { k: "canvas" } }) },
}));
vi.mock("@/shared/brand/botToastStore", () => ({ showBotToast: m.toast }));
vi.mock("../terminalRegistry", () => ({ insertIntoTab: m.insertIntoTab, focusTab: m.focusTab }));
// O menu de verdade usa `popover` e o Button da neogestify: aqui basta um botão por item.
vi.mock("@/shared/ui/ContextMenu", () => ({
  ContextMenu: ({ items, onClose }: { items: Array<{ key: string; label: string; disabled?: boolean; onSelect: () => void }>; onClose: () => void }) => (
    <div data-menu>
      {items.map((item) => (
        <button key={item.key} data-item={item.key} disabled={item.disabled} onClick={() => { item.onSelect(); onClose(); }}>{item.label}</button>
      ))}
    </div>
  ),
}));

import { ExcerptAction } from "../ExcerptAction";

/** O xterm com uma seleção nas linhas 30–31 do buffer (0-based 29–30). */
function fakeTerm() {
  const listeners: Array<() => void> = [];
  const lines: Record<number, string> = { 29: "erro: falhou", 30: "  em main.rs:4" };
  let selected = true;
  const term = {
    rows: 24,
    cols: 80,
    buffer: { active: { viewportY: 20, getLine: (y: number) => ({ translateToString: () => lines[y] ?? "" }) } },
    hasSelection: () => selected,
    getSelection: () => (selected ? "erro: falhou\r\n  em main.rs:4" : ""),
    getSelectionPosition: () => (selected ? { start: { x: 0, y: 29 }, end: { x: 14, y: 30 } } : undefined),
    onSelectionChange: (fn: () => void) => { listeners.push(fn); return { dispose: () => undefined }; },
    onScroll: () => ({ dispose: () => undefined }),
    onResize: () => ({ dispose: () => undefined }),
  };
  return {
    term: term as unknown as import("@xterm/xterm").Terminal,
    select: (on: boolean) => { selected = on; listeners.forEach((fn) => fn()); },
  };
}

describe("ExcerptAction", () => {
  // A caixa do terminal (com a tela do xterm) e, à parte, onde o React desenha: ele limpa o contêiner.
  let host: HTMLDivElement;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    host.innerHTML = '<div class="xterm-screen"></div>';
    container = document.createElement("div");
    document.body.append(host, container);
    root = createRoot(container);
    m.tabs = [
      { id: "src", title: "Claude Code — app", agentId: "claude-code", agentLabel: "Claude Code", cwd: "/p" },
      { id: "other", title: "Revisor", agentId: "codex", agentLabel: "Codex", cwd: "/p" },
      { id: "sh", title: "bash", agentId: "bash", agentLabel: "Terminal", cwd: "/p" },
    ];
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const pill = () => container.querySelector<HTMLButtonElement>('button[aria-label="terminal.excerpt.actionHint"]');
  const item = (key: string) => document.querySelector<HTMLButtonElement>(`[data-item="${key}"]`);

  function mount() {
    const fake = fakeTerm();
    act(() => root.render(<ExcerptAction tabId="src" term={fake.term} host={host} />));
    act(() => { fake.select(true); vi.advanceTimersByTime(200); });
    return fake;
  }

  it("mostra o botão com a seleção e some sem ela", () => {
    const fake = mount();
    expect(pill()).not.toBeNull();
    act(() => { fake.select(false); vi.advanceTimersByTime(200); });
    expect(pill()).toBeNull();
  });

  it("lista o chat desta aba e os outros agentes, sem terminais de shell", () => {
    mount();
    act(() => pill()!.click());
    expect(item("chat")).not.toBeNull();
    expect(item("other")?.textContent).toBe("Codex · Revisor");
    expect(item("sh")).toBeNull();
    expect(item("src")).toBeNull();
  });

  it("cola no outro agente sem Enter, com cabeçalho e linhas, e passa o foco a ele", () => {
    m.insertIntoTab.mockReturnValue("ok");
    mount();
    act(() => pill()!.click());
    act(() => item("other")!.click());
    const [tabId, text] = m.insertIntoTab.mock.calls[0];
    expect(tabId).toBe("other");
    expect(text).toBe('terminal.excerpt.header {"source":"Claude Code — app","from":30,"to":31}\n```\nerro: falhou\n  em main.rs:4\n```\n');
    expect(m.activateTab).toHaveBeenCalledWith("other");
  });

  it("avisa quando o agente não está rodando, sem trocar de aba", () => {
    m.insertIntoTab.mockReturnValue("offline");
    mount();
    act(() => pill()!.click());
    act(() => item("other")!.click());
    expect(m.activateTab).not.toHaveBeenCalled();
    expect(m.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "warning" }));
  });

  it("leva o trecho ao rascunho do chat desta aba", () => {
    mount();
    act(() => pill()!.click());
    act(() => item("chat")!.click());
    expect(m.setJump).toHaveBeenCalledWith({ tabId: "src", thread: "", text: expect.stringContaining("```\nerro: falhou") });
    expect(m.insertIntoTab).not.toHaveBeenCalled();
  });

  it("abre o mesmo menu pelo clique direito com texto selecionado", () => {
    mount();
    act(() => { host.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    expect(item("copy")).not.toBeNull();
    act(() => item("send")!.click());
    expect(item("other")).not.toBeNull();
  });
});
