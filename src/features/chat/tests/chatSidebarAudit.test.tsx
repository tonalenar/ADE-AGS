// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onResized: () => Promise.resolve(() => undefined), isMaximized: () => Promise.resolve(false) }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o && "count" in o ? `${key}:${o.count}` : key), i18n: { language: "pt-BR" } }) }));

import { useUiStore } from "@/app/uiStore";
import { useTabsStore } from "@/features/tabs/store";
import type { ConversationCard } from "../chatModel";
import { ChatSidebar } from "../ChatSidebar";
import { useChatStore } from "../store";
import { useShelf } from "../shelf";
import { useStructured } from "../structured/store";
import { useTeamStore } from "../team/teamStore";

const card = (id: string, project: string, title: string): ConversationCard => ({
  tabId: id, title, project, cwd: `/p/${project}`, branch: "main", isWorktree: false, agentId: "claude-code", agentLabel: "Claude Code", starting: false, active: false, openedAt: 1,
});
const CARDS = [card("a", "ADE-AGS", "Primeira conversa"), card("b", "Outro", "Segunda conversa")];

const calls = { collapse: 0, addProject: 0, reopen: [] as string[] };
let root: Root;
let host: HTMLDivElement;
let where = "";
function Where() { where = useLocation().pathname; return null; }

const mount = (props: Partial<React.ComponentProps<typeof ChatSidebar>> = {}) => act(async () => {
  root.render(
    <MemoryRouter>
      <Where />
      <ChatSidebar cards={CARDS} closed={[]} diffs={{}} selectedId="a" onCollapse={() => { calls.collapse++; }} onAddProject={() => { calls.addProject++; }}
        onReopen={(cwd) => { calls.reopen.push(cwd); }} {...props} />
    </MemoryRouter>,
  );
});
const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"], [title="${label}"]`) as HTMLElement | null;
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  calls.collapse = 0; calls.addProject = 0; calls.reopen = []; where = "";
  useShelf.setState({ snoozed: [], settled: [] });
  useChatStore.setState({ composing: false });
  useStructured.setState({ threads: [], live: {}, hydrated: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("auditoria: cada botão da barra do modo chat", () => {
  it("recolher chama o handler", async () => {
    await mount();
    await click(byLabel("chat.sidebar.collapse"));
    expect(calls.collapse).toBe(1);
  });

  it("adicionar projeto chama o handler", async () => {
    await mount();
    await click(byLabel("chat.sidebar.addProject"));
    expect(calls.addProject).toBe(1);
  });

  it("nova conversa abre a tela de conversa nova", async () => {
    await mount();
    await click(byLabel("chat.sidebar.new"));
    expect(useChatStore.getState().composing).toBe(true);
  });

  it("a busca filtra os cartões", async () => {
    await mount();
    await click(byLabel("chat.sidebar.nav.search"));
    const input = host.querySelector("input") as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "segunda");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("Segunda conversa");
    expect(host.textContent).not.toContain("Primeira conversa");
  });

  it("o filtro por pasta abre o menu e filtra", async () => {
    await mount();
    await click(byLabel("chat.sidebar.nav.search"));
    await click(byLabel("chat.sidebar.filter"));
    const item = [...host.querySelectorAll("[role=menuitemradio]")].find((b) => b.textContent?.includes("Outro"));
    expect(item).toBeTruthy();
    await click(item!);
    expect(host.textContent).toContain("Segunda conversa");
    expect(host.textContent).not.toContain("Primeira conversa");
  });

  it("o cartão abre a conversa (ativa a aba)", async () => {
    const { useTabsStore } = await import("@/features/tabs/store");
    const activate = vi.spyOn(useTabsStore.getState(), "activateTab").mockImplementation(() => undefined as never);
    await mount();
    await click([...host.querySelectorAll("[role=button]")].find((b) => b.textContent?.includes("Segunda conversa")) ?? null);
    expect(activate).toHaveBeenCalledWith("b");
  });

  it("adiar (pelo menu ⋯) tira da lista e aparece em Adiadas", async () => {
    await mount();
    await click(host.querySelector("[data-session-id='a'] [aria-label='chat.sidebar.more']"));
    const snooze = [...document.querySelectorAll("button, [role=menuitem]")].find((b) => b.textContent?.includes("chat.sidebar.snooze"));
    await click(snooze!);
    expect(useShelf.getState().snoozed).toEqual(["a"]);
    expect(host.querySelector("[data-session-id='a']")).toBeNull();
  });

  it("Personalização leva às Configurações; o ··· Mais leva a PRs e Uso", async () => {
    await mount();
    await click(byLabel("sidebar.settings"));
    expect(where).toBe("/settings");
    const more = async (label: string) => {
      await click(byLabel("chat.sidebar.nav.more"));
      await click([...document.querySelectorAll("button, [role=menuitem]")].find((b) => b.textContent?.includes(label)) ?? null);
    };
    await more("chat.sidebar.pullRequests");
    expect(where).toBe("/forge");
    await more("chat.sidebar.usage");
    expect(where).toBe("/settings");
    expect(useUiStore.getState().settingsSection).toBe("accounts");
  });

  it("Concluídas: abrir o cabeçalho lista as pastas fechadas e reabrir chama o handler", async () => {
    await mount({ closed: [{ cwd: "/p/Velha", name: "Velha", branch: null }] });
    await click([...host.querySelectorAll("button[aria-expanded]")].find((b) => b.textContent?.includes("chat.sidebar.closed")) ?? null);
    await click([...host.querySelectorAll("button")].find((b) => b.getAttribute("title") === "chat.sidebar.reopen") ?? null);
    expect(calls.reopen).toEqual(["/p/Velha"]);
  });
});

describe("as funções da barra (Fixadas, renomear, lida, menu, teclado)", () => {
  const cardEl = (title: string) => [...host.querySelectorAll("[data-session-id]")].find((b) => b.textContent?.includes(title)) as HTMLElement;
  const key = (el: Element, k: string, init: KeyboardEventInit = {}) => act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  beforeEach(() => { useShelf.setState({ snoozed: [], settled: [], pinned: [], unread: [], collapsed: [] }); });

  it("as conversas aparecem agrupadas por projeto, com o cabeçalho recolhível que lembra o estado", async () => {
    await mount();
    const headers = [...host.querySelectorAll("section > div > button[aria-expanded]")];
    expect(headers.map((h) => h.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("ADE-AGS"), expect.stringContaining("Outro")]));
    await click(headers.find((h) => h.textContent?.includes("Outro"))!);
    expect(useShelf.getState().collapsed).toEqual(["project:Outro"]);
    expect(host.textContent).not.toContain("Segunda conversa");
  });

  it("o menu (clique direito) fixa: a conversa vai para a seção Fixadas e a marca persiste", async () => {
    await mount();
    await act(async () => { cardEl("Segunda").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    const pin = [...document.querySelectorAll("button, [role=menuitem]")].find((b) => b.textContent?.includes("chat.sidebar.pin"));
    expect(pin).toBeTruthy();
    await click(pin!);
    expect(useShelf.getState().pinned).toEqual(["b"]);
    expect(host.querySelector("section[aria-label='chat.sidebar.pinned']")?.textContent).toContain("Segunda conversa");
  });

  it("o botão ⋯ abre o menu com as ações", async () => {
    await mount();
    await click(cardEl("Primeira").querySelector("[aria-label='chat.sidebar.more']"));
    const labels = [...document.querySelectorAll("button, [role=menuitem]")].map((b) => b.textContent ?? "");
    for (const wanted of ["chat.sidebar.pin", "chat.sidebar.rename", "chat.sidebar.markUnread", "chat.sidebar.settle"]) {
      expect(labels.some((l) => l.includes(wanted))).toBe(true);
    }
  });

  it("F2 renomeia a aba: Enter confirma, Esc cancela, vazio não renomeia", async () => {
    const rename = vi.spyOn(useTabsStore.getState(), "renameTab").mockImplementation(() => undefined as never);
    await mount();
    await key(cardEl("Primeira"), "F2");
    const input = host.querySelector("input[aria-label='chat.sidebar.renameLabel']") as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => { input.value = "  Novo   nome "; });
    await key(input, "Enter");
    expect(rename).toHaveBeenCalledWith("a", "Novo nome");
    expect(host.querySelector("input[aria-label='chat.sidebar.renameLabel']")).toBeNull();
    rename.mockClear();
    await key(cardEl("Primeira"), "F2");
    await key(host.querySelector("input[aria-label='chat.sidebar.renameLabel']")!, "Escape");
    expect(rename).not.toHaveBeenCalled();
  });

  it("Marcar como não lida deixa o ponto e o título em negrito; abrir a conversa limpa", async () => {
    await mount();
    await act(async () => { useShelf.setState({ unread: ["b"] }); });
    expect(cardEl("Segunda").querySelector("[aria-label='chat.sidebar.unread']")).not.toBeNull();
    const activate = vi.spyOn(useTabsStore.getState(), "activateTab").mockImplementation(() => undefined as never);
    await click(cardEl("Segunda"));
    expect(activate).toHaveBeenCalledWith("b");
    expect(useShelf.getState().unread).toEqual([]);
  });

  it("↑ ↓ andam entre as conversas, na ordem da tela, e param nas pontas", async () => {
    await mount();
    const els = () => [...host.querySelectorAll<HTMLElement>("[data-session-id]")];
    const [one, two] = els();
    await act(async () => { one!.focus(); });
    await key(one!, "ArrowDown");
    expect(document.activeElement).toBe(two);
    await key(two!, "ArrowUp");
    expect(document.activeElement).toBe(one);
    await key(one!, "ArrowUp");
    expect(document.activeElement).toBe(one);
  });

  it("o foco por teclado é visível e os botões têm nome acessível", async () => {
    await mount();
    expect(cardEl("Primeira").className).toContain("focus-visible:ring");
    for (const label of ["chat.sidebar.collapse", "chat.sidebar.back", "chat.sidebar.forward", "chat.sidebar.addProject", "chat.sidebar.new", "chat.sidebar.nav.search", "chat.sidebar.nav.artifacts", "chat.sidebar.nav.more"]) expect(byLabel(label)).not.toBeNull();
  });
});

describe("a hierarquia da barra do Claude Code (uma linha, filhas, menus restaurados)", () => {
  const items = () => [...document.querySelectorAll("button, [role=menuitem]")].map((b) => b.textContent ?? "");
  const TEAM = {
    id: "t1", orchestrator: "a", agentId: "claude-code", label: "Claude", cwd: "/p/ADE-AGS", title: "", createdAt: 1, updatedAt: 1, headcount: 2,
    members: [{ teamId: "t1", member: "b", agentId: "codex", label: "Codex", role: "qa", model: null, policy: "ask", branch: null, worktree: null, origin: "existing", position: 0, createdAt: 1, updatedAt: 1, subagent: false }],
  };
  beforeEach(() => { useShelf.setState({ snoozed: [], settled: [], pinned: [], unread: [], collapsed: [] }); useTeamStore.setState({ teams: [], loaded: true } as never); });

  it("cada conversa é UMA linha de 32 px (não o cartão de 78 px)", async () => {
    await mount();
    const row = host.querySelector("[data-session-id='a']") as HTMLElement;
    expect(row.className).toContain("h-8");
    expect(row.className).not.toContain("h-[78px]");
  });

  it("os integrantes do time ficam indentados sob o orquestrador, com ⑂ N e a seta que os esconde", async () => {
    useTeamStore.setState({ teams: [TEAM as never] });
    await mount();
    expect(host.querySelector("[data-session-id='b']")).toBeNull();
    expect(host.querySelector("[role=group]")?.textContent).toContain("Segunda conversa");
    const row = host.querySelector("[data-session-id='a']") as HTMLElement;
    expect(row.textContent).toContain("1");
    await click(row.querySelector("button[aria-label='chat.sidebar.kids']"));
    expect(host.querySelector("[role=group]")).toBeNull();
  });

  it("o menu da conversa traz as ações restauradas do painel antigo (Skills e Fechar)", async () => {
    await mount();
    await click(host.querySelector("[data-session-id='a'] [aria-label='chat.sidebar.more']"));
    const labels = items();
    for (const wanted of ["skills.scope.tabAction", "tabs.close", "chat.sidebar.pin", "chat.sidebar.rename"]) expect(labels.some((l) => l.includes(wanted))).toBe(true);
  });

  it("o menu do projeto tem expandir/recolher todos, Skills do workspace e Fechar workspace; recolher todos grava", async () => {
    await mount();
    await click(host.querySelector("[aria-label='chat.sidebar.group.more']"));
    const labels = items();
    for (const wanted of ["chat.sidebar.group.collapseAll", "skills.scope.workspaceAction", "workspaces.close"]) expect(labels.some((l) => l.includes(wanted))).toBe(true);
    await click([...document.querySelectorAll("button, [role=menuitem]")].find((b) => b.textContent?.includes("chat.sidebar.group.collapseAll")) ?? null);
    expect(useShelf.getState().collapsed.sort()).toEqual(["project:ADE-AGS", "project:Outro"]);
  });

  it("o ··· Mais mostra a contagem rodando/iniciando", async () => {
    await mount();
    await click(byLabel("chat.sidebar.nav.more"));
    expect(items().some((l) => l.includes("chat.sidebar.counts"))).toBe(true);
  });

  it("o rodapé tem o avatar com a inicial, o nome e as Configurações", async () => {
    await mount();
    expect(host.querySelector("aside")?.textContent).toContain("chat.sidebar.account");
    expect(host.querySelector("aside [aria-label='sidebar.settings']")).not.toBeNull();
  });
});
