// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onResized: () => Promise.resolve(() => undefined) }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@/features/missions/MissionsSection", () => ({ MissionsSection: () => <div data-testid="missoes" /> }));
vi.mock("@/features/missions/groups", () => ({ useMissionIndex: () => ({ "tab-m": "mission-1" }) }));
vi.mock("@/shared/brand/Pet", () => ({ usePetStatus: () => ({}), PetCard: () => <div data-testid="pet" /> }));

import { useTabsStore } from "@/features/tabs/store";
import type { RepoGroup } from "@/features/workspaces/workspaceTree";

import { AppSessionsSidebar } from "../sidebar/AppSessionsSidebar";

const agent = (tabId: string, title: string) => ({ tabId, title, agentId: "claude-code", agentLabel: "Claude Code", status: "running", isActive: false, openedAt: 5 });
const GROUPS = [{
  key: "/p/ADE", workspaces: [{ key: "w1", cwd: "/p/ADE", title: "ADE", branch: "main", isWorktree: false, closed: false, agents: [agent("tab-a", "Conversa A"), agent("tab-m", "Da missão")] }],
}] as unknown as RepoGroup[];

let root: Root;
let host: HTMLDivElement;
let where = "";
function Where() { where = useLocation().pathname; return null; }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  where = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const mount = () => act(async () => { root.render(<MemoryRouter initialEntries={["/settings"]}><Where /><AppSessionsSidebar groups={GROUPS} width={272} /></MemoryRouter>); });

describe("a barra de sessões nas Abas e no Canvas", () => {
  it("é a mesma barra do chat: cartões das conversas, sem o cabeçalho nem o rodapé do chat", async () => {
    await mount();
    expect(host.textContent).toContain("Conversa A");
    expect(host.querySelector("[aria-label='chat.sidebar.collapse']")).toBeNull();
    expect(host.querySelector("[title='chat.sidebar.account']")).toBeNull();
    expect(host.querySelector("[aria-label='chat.sidebar.new']")).not.toBeNull();
  });

  it("mantém as missões no alto e o pet embaixo, e as terminais de missão ficam fora da lista", async () => {
    await mount();
    expect(host.querySelector("[data-testid=missoes]")).not.toBeNull();
    expect(host.querySelector("[data-testid=pet]")).not.toBeNull();
    expect(host.textContent).not.toContain("Da missão");
  });

  it("abrir uma conversa ativa a aba e leva à tela do workspace", async () => {
    const activate = vi.spyOn(useTabsStore.getState(), "activateTab").mockImplementation(() => undefined as never);
    await mount();
    await act(async () => { (host.querySelector("[data-session-id='tab-a']") as HTMLElement).click(); });
    expect(activate).toHaveBeenCalledWith("tab-a");
    expect(where).toBe("/workspace");
  });

  it("nova conversa e adicionar projeto levam à tela inicial", async () => {
    await mount();
    await act(async () => { (host.querySelector("[aria-label='chat.sidebar.new']") as HTMLElement).click(); });
    expect(where).toBe("/");
  });
});
