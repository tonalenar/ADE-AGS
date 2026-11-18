/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const resetDefaultWorkspace = vi.fn();
vi.mock("@/features/workspaces/store", () => ({
  useWorkspacesStore: (selector: (s: { resetDefaultWorkspace: () => Promise<void> }) => unknown) => selector({ resetDefaultWorkspace }),
}));
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

import { ResetDefaultDialog } from "../ResetDefaultDialog";

describe("ResetDefaultDialog", () => {
  it("resetar_falho_mostra_o_erro_e_nao_fecha", async () => {
    resetDefaultWorkspace.mockRejectedValueOnce(new Error("disco cheio"));
    const onClose = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<ResetDefaultDialog onClose={onClose} />); });
    const confirm = [...host.querySelectorAll("button")].find((b) => b.textContent === "workspace.resetDefault.confirm");
    await act(async () => { confirm?.click(); });
    // Antes a confirmação falhava em silêncio: agora o erro aparece e o diálogo continua aberto.
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("disco cheio");
    await act(async () => { root.unmount(); });
    host.remove();
  });
});
