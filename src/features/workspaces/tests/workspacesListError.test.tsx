/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ipcMock = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  openWindowsOf: vi.fn(),
  resetDefaultWorkspace: vi.fn(),
  saveWorkspace: vi.fn(),
  openWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));
vi.mock("../ipc", () => ipcMock);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
const t = vi.hoisted(() => (key: string) => key);
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }) }));
vi.mock("@/features/tabs/store", () => ({ useTabsStore: { getState: () => ({ workspaceId: "w" }) } }));
vi.mock("@/features/skills/store", () => ({ useSkillsStore: { getState: () => ({ checkHealth: async () => [] }) } }));
vi.mock("@/shared/ipc/window", () => ({ broadcastEvent: vi.fn(async () => undefined), focusWindow: vi.fn(async () => undefined) }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: vi.fn() }));
vi.mock("@/shared/ui/PageHeader", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock("../DeletedWorkspacesList", () => ({ DeletedWorkspacesList: () => null }));
vi.mock("../OpenWorkspaceDialog", () => ({ OpenWorkspaceDialog: () => null }));
vi.mock("../DeleteWorkspaceDialog", () => ({ DeleteWorkspaceDialog: () => null }));
vi.mock("neogestify-ui-components", () => {
  const Icon = () => null;
  return {
    Button: ({ children, variant: _v, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => <button {...rest}>{children}</button>,
    Input: () => null,
    EditIcon: Icon, TrashIcon: Icon, CheckIcon: Icon, CancelIcon: Icon, BoxIcon: Icon,
  };
});

import { WorkspacesPage } from "../WorkspacesPage";
import { useWorkspacesStore } from "../store";

let host: HTMLDivElement;
let root: Root;

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); });
}

beforeEach(async () => {
  vi.clearAllMocks();
  useWorkspacesStore.setState({ workspaces: [], loading: false, error: null });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("WorkspacesPage: falha ao listar", () => {
  it("mostra o erro com Tentar de novo, e não o texto de 'nenhum salvo'", async () => {
    ipcMock.listWorkspaces.mockRejectedValueOnce({ kind: "db", message: "banco travado" }).mockResolvedValue([]);
    await act(async () => { root.render(<WorkspacesPage />); });
    await flush();
    expect(host.textContent).toContain("banco travado");
    expect(host.textContent).not.toContain("home.recent.empty");
  });

  it("Tentar de novo chama a listagem outra vez e, com sucesso, some o erro", async () => {
    ipcMock.listWorkspaces.mockRejectedValueOnce(new Error("falhou")).mockResolvedValue([]);
    await act(async () => { root.render(<WorkspacesPage />); });
    await flush();
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "btn.retry");
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); });
    await flush();
    expect(ipcMock.listWorkspaces).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain("falhou");
    expect(host.textContent).toContain("home.recent.empty");
  });
});
