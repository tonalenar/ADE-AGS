// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
const search = vi.hoisted(() => ({ shell: "/bin/zsh" as string | null }));
vi.mock("@/features/agents/ipc", () => ({ agentSearchPath: () => Promise.resolve({ shell: search.shell, shellOk: true, shellError: null, fromShell: [], known: [], effective: [] }) }));

import { useTabsStore } from "@/features/tabs/store";

import { rectInShell } from "../RightPanel";
import { ensureShellTab, resetLoginShell } from "../shellTerminal";

/** Um elemento com o retângulo dado (o happy-dom não faz layout). */
function box(el: HTMLElement, left: number, top: number, width: number, height: number): HTMLElement {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  return el;
}

describe("onde o terminal da conversa é desenhado", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("o retângulo do slot é relativo à casca do chat, não ao próprio slot", () => {
    const shell = box(document.createElement("div"), 0, 0, 1000, 860);
    shell.setAttribute("data-chat-shell", "");
    const panel = box(document.createElement("aside"), 640, 52, 360, 808);
    // O slot do terminal carregava o MESMO atributo da casca: a base virava o próprio slot e o retângulo saía em
    // (0, 0) — o terminal aparecia no canto de cima, por cima da sidebar e dos semáforos.
    const slot = box(document.createElement("div"), 648, 96, 344, 756);
    slot.setAttribute("data-chat-shell", "t1");
    panel.appendChild(slot);
    shell.appendChild(panel);
    document.body.appendChild(shell);
    expect(rectInShell(slot)).toEqual({ left: 648, top: 96, width: 344, height: 756 });
  });

  it("sem casca, ou antes do layout (tamanho zero), não posiciona nada", () => {
    const loose = box(document.createElement("div"), 10, 10, 100, 100);
    document.body.appendChild(loose);
    expect(rectInShell(loose)).toBeNull();
    const shell = document.createElement("div");
    shell.setAttribute("data-chat-shell", "");
    const slot = box(document.createElement("div"), 0, 0, 0, 0);
    shell.appendChild(slot);
    document.body.appendChild(shell);
    expect(rectInShell(slot)).toBeNull();
  });
});

describe("o shell do terminal da conversa", () => {
  beforeEach(() => {
    resetLoginShell();
    search.shell = "/bin/zsh";
    useTabsStore.setState({ tabs: [], activeTabId: "conversa" });
  });

  it("é o shell de login da pessoa (zsh), não o bash 3.2 do agente de shell", async () => {
    const id = await act(() => ensureShellTab("/repo"));
    const tab = useTabsStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.command).toBe('"/bin/zsh" -l');
    expect(tab.agentId).toBe("bash");
    expect(useTabsStore.getState().activeTabId).toBe("conversa");
  });

  it("dois pedidos seguidos na mesma pasta dão uma aba só", async () => {
    const [a, b] = await act(() => Promise.all([ensureShellTab("/repo"), ensureShellTab("/repo")]));
    expect(a).toBe(b);
    expect(useTabsStore.getState().tabs.filter((t) => t.agentId === "bash")).toHaveLength(1);
  });

  it("a aba bash que o >_ abria antes não vira o terminal da conversa: abre uma com o shell de login", async () => {
    useTabsStore.setState({ tabs: [{ id: "velha", agentId: "bash", cwd: "/repo", command: "bash" } as never], activeTabId: "conversa" });
    const id = await act(() => ensureShellTab("/repo"));
    expect(id).not.toBe("velha");
    expect(useTabsStore.getState().tabs.find((t) => t.id === id)!.command).toBe('"/bin/zsh" -l');
  });

  it("sem shell de login (Windows), fica o terminal padrão do app", async () => {
    search.shell = null;
    const id = await act(() => ensureShellTab("/repo"));
    expect(useTabsStore.getState().tabs.find((t) => t.id === id)!.command).toBe("bash");
  });
});
