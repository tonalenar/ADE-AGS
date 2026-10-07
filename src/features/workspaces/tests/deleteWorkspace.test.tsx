/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("react-i18next", () => {
  const t = (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k);
  return { useTranslation: () => ({ t }) };
});
vi.mock("@/shared/ui/AppDialog", () => ({
  AppDialog: ({ title, footer, children }: { title: string; footer: React.ReactNode; children: React.ReactNode }) => (
    <div role="dialog" aria-label={title}>{children}<div data-footer>{footer}</div></div>
  ),
}));
vi.mock("neogestify-ui-components", () => ({
  Button: ({ children, variant: _v, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => <button {...rest}>{children}</button>,
}));

import { DeleteWorkspaceDialog } from "../DeleteWorkspaceDialog";
import { DeletedWorkspacesList } from "../DeletedWorkspacesList";
import { deleteWithChoice, isExpiringSoon, remainingDays } from "../deleteWorkspaceFlow";

describe("deleteWorkspaceFlow", () => {
  it("remainingDays arredonda para cima e trata ausência", () => {
    expect(remainingDays(27 * 86400)).toBe(27);
    expect(remainingDays(86400 + 1)).toBe(2);
    expect(remainingDays(0)).toBe(0);
    expect(remainingDays(-5)).toBe(0);
    expect(remainingDays(null)).toBeNull();
    expect(remainingDays(Number.NaN)).toBeNull();
    expect(isExpiringSoon(2)).toBe(true);
    expect(isExpiringSoon(27)).toBe(false);
    expect(isExpiringSoon(null)).toBe(false);
  });

  it("exportar e apagar: exporta antes e só depois apaga", async () => {
    const order: string[] = [];
    invokeMock.mockImplementation(async (cmd: string) => { order.push(cmd); return {}; });
    await deleteWithChoice("w1", "export", async () => { order.push("delete"); });
    expect(order).toEqual(["memory_export", "delete"]);
  });

  it("falha na exportação: não apaga", async () => {
    invokeMock.mockRejectedValue(new Error("disk full"));
    const remove = vi.fn();
    await expect(deleteWithChoice("w1", "export", remove)).rejects.toThrow("disk full");
    expect(remove).not.toHaveBeenCalled();
  });

  it("apagar sem exportar não chama memory_export", async () => {
    invokeMock.mockReset();
    const remove = vi.fn().mockResolvedValue(undefined);
    await deleteWithChoice("w1", "skip", remove);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("w1");
  });
});

describe("telas", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    invokeMock.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const mount = async (el: React.ReactElement) => {
    await act(async () => { root.render(el); });
    await act(async () => {});
  };
  const buttons = () => Array.from(host.querySelectorAll("button"));
  const byText = (txt: string) => buttons().find((b) => b.textContent?.includes(txt))!;

  it("diálogo: 3 opções, contagem de entradas e foco inicial em Exportar e apagar", async () => {
    invokeMock.mockResolvedValue({ entries: 41 });
    await mount(<DeleteWorkspaceDialog workspaceId="w1" workspaceName="meu-app" remove={vi.fn()} onClose={vi.fn()} />);
    expect(buttons().map((b) => b.textContent)).toEqual(["workspaceDelete.cancel", "workspaceDelete.skip", "workspaceDelete.export"]);
    expect(host.textContent).toContain('"count":41');
    expect(byText("workspaceDelete.export").hasAttribute("autofocus") || document.activeElement === byText("workspaceDelete.export")).toBe(true);
  });

  it("diálogo: Exportar e apagar chama export, apaga e fecha", async () => {
    invokeMock.mockResolvedValue({ entries: 1 });
    const remove = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    await mount(<DeleteWorkspaceDialog workspaceId="w1" workspaceName="x" remove={remove} onClose={onClose} />);
    await act(async () => { byText("workspaceDelete.export").click(); });
    expect(invokeMock).toHaveBeenCalledWith("memory_export", { workspaceId: "w1" });
    expect(remove).toHaveBeenCalledWith("w1");
    expect(onClose).toHaveBeenCalled();
  });

  it("diálogo: falha na exportação mostra erro e não apaga nem fecha", async () => {
    invokeMock.mockImplementation(async (cmd: string) => { if (cmd === "memory_export") throw new Error("boom"); return { entries: 1 }; });
    const remove = vi.fn();
    const onClose = vi.fn();
    await mount(<DeleteWorkspaceDialog workspaceId="w1" workspaceName="x" remove={remove} onClose={onClose} />);
    await act(async () => { byText("workspaceDelete.export").click(); });
    expect(remove).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("workspaceDelete.exportFailed");
  });

  it("diálogo: Apagar sem exportar não exporta", async () => {
    invokeMock.mockResolvedValue({ entries: 1 });
    const remove = vi.fn().mockResolvedValue(undefined);
    await mount(<DeleteWorkspaceDialog workspaceId="w1" workspaceName="x" remove={remove} onClose={vi.fn()} />);
    invokeMock.mockClear();
    await act(async () => { byText("workspaceDelete.skip").click(); });
    expect(invokeMock).not.toHaveBeenCalledWith("memory_export", expect.anything());
    expect(remove).toHaveBeenCalledWith("w1");
  });

  it("diálogo: Cancelar não apaga", async () => {
    invokeMock.mockResolvedValue({ entries: 1 });
    const remove = vi.fn();
    const onClose = vi.fn();
    await mount(<DeleteWorkspaceDialog workspaceId="w1" workspaceName="x" remove={remove} onClose={onClose} />);
    await act(async () => { byText("workspaceDelete.cancel").click(); });
    expect(onClose).toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("diálogo: nome com HTML vira texto", async () => {
    invokeMock.mockResolvedValue({ entries: 1 });
    await mount(<DeleteWorkspaceDialog workspaceId="w1" workspaceName="<img src=x onerror=1>" remove={vi.fn()} onClose={vi.fn()} />);
    expect(host.querySelector("img")).toBeNull();
  });

  it("lixeira: lista com prazo e Restaurar chama workspace_restore e recarrega", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "workspace_deleted_list"
        ? [{ id: "a", name: "meu-app", deletedAt: 1, deleteAfter: 2, remainingSeconds: 27 * 86400 }, { id: "b", name: "api", deletedAt: 1, deleteAfter: 2, remainingSeconds: 2 * 86400 }]
        : undefined);
    const onRestored = vi.fn();
    await mount(<DeletedWorkspacesList onRestored={onRestored} />);
    expect(host.textContent).toContain('"count":27');
    expect(host.textContent).toContain('"count":2');
    await act(async () => { buttons()[0].click(); });
    expect(invokeMock).toHaveBeenCalledWith("workspace_restore", { workspaceId: "a" });
    expect(onRestored).toHaveBeenCalled();
    expect(invokeMock.mock.calls.filter((c) => c[0] === "workspace_deleted_list").length).toBe(2);
  });

  it("lixeira: vazio, erro com 'tentar de novo' e falha ao restaurar", async () => {
    invokeMock.mockResolvedValue([]);
    await mount(<DeletedWorkspacesList />);
    expect(host.textContent).toContain("workspaceDelete.deletedEmpty");
    act(() => root.unmount());
    root = createRoot(host);
    invokeMock.mockRejectedValue(new Error("x"));
    await mount(<DeletedWorkspacesList />);
    expect(host.textContent).toContain("workspaceDelete.listFailed");
    expect(byText("workspaceDelete.retry")).toBeTruthy();
  });

  it("lixeira: falha ao restaurar mostra erro", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "workspace_restore") throw new Error("nope");
      return [{ id: "a", name: "n", deletedAt: 1, deleteAfter: null, remainingSeconds: null }];
    });
    await mount(<DeletedWorkspacesList />);
    expect(host.textContent).toContain("workspaceDelete.noDeadline");
    await act(async () => { buttons()[0].click(); });
    expect(host.textContent).toContain("workspaceDelete.restoreFailed");
  });
});
