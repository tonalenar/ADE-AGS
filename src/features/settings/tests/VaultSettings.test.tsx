// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VaultEntry } from "@/features/vault/types";

const vaultListMock = vi.fn<() => Promise<VaultEntry[]>>();
const vaultAddMock = vi.fn();
const vaultUpdateMock = vi.fn();
const vaultRemoveMock = vi.fn();
const vaultRevokeAgentMock = vi.fn();

vi.mock("@/features/vault/ipc", () => ({
  vaultList: () => vaultListMock(),
  vaultAdd: (...args: unknown[]) => vaultAddMock(...args),
  vaultUpdate: (...args: unknown[]) => vaultUpdateMock(...args),
  vaultRemove: (...args: unknown[]) => vaultRemoveMock(...args),
  vaultRevokeAgent: (...args: unknown[]) => vaultRevokeAgentMock(...args),
  vaultAllowAgent: vi.fn(),
  vaultSecretForFill: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

import { VaultSettings } from "../vault/VaultSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRIES: VaultEntry[] = [
  {
    id: "v-1",
    origin: "https://conta.exemplo.com",
    username: "ton@exemplo.com",
    label: "Conta Exemplo",
    created_at: 1700000000,
    last_used_at: 1700003600,
    allowed_agents: ["tab-1"],
  },
];

let container: HTMLDivElement;
let root: Root;

async function renderVault() {
  await act(async () => {
    root.render(createElement(VaultSettings));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  vaultListMock.mockReset();
  vaultAddMock.mockReset();
  vaultUpdateMock.mockReset();
  vaultRemoveMock.mockReset();
  vaultRevokeAgentMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("VaultSettings (Configurações → Cofre)", () => {
  it("lista_sem_senha", async () => {
    vaultListMock.mockResolvedValueOnce(ENTRIES);
    await renderVault();

    expect(container.textContent).toContain("Conta Exemplo");
    expect(container.textContent).toContain("https://conta.exemplo.com");
    expect(container.textContent).toContain("ton@exemplo.com");
    expect(container.textContent).toContain("tab-1");
    // Nenhum campo de texto/botão revela senha; não há botão de revelar.
    expect(container.querySelector('[data-testid="vault-reveal"]')).toBeNull();
    expect(container.innerHTML.toLowerCase()).not.toContain("revelar");
  });

  it("trocar_senha_chama_update_sem_exibir", async () => {
    vaultListMock.mockResolvedValueOnce(ENTRIES);
    vaultUpdateMock.mockResolvedValueOnce(ENTRIES[0]);
    await renderVault();

    const changeBtn = container.querySelector<HTMLButtonElement>('[data-testid="vault-change-pw-v-1"]');
    expect(changeBtn).not.toBeNull();
    await act(async () => {
      changeBtn!.click();
    });

    const pwInput = container.querySelector<HTMLInputElement>('[data-testid="vault-new-pw-v-1"]');
    expect(pwInput).not.toBeNull();
    expect(pwInput!.type).toBe("password");

    const novaSenha = "NovaSenhaSuperSecreta!2026";
    await act(async () => {
      setInputValue(pwInput!, novaSenha);
    });

    const saveBtn = container.querySelector<HTMLButtonElement>('[data-testid="vault-save-pw-v-1"]');
    expect(saveBtn).not.toBeNull();
    await act(async () => {
      saveBtn!.click();
    });

    expect(vaultUpdateMock).toHaveBeenCalledWith("v-1", { password: novaSenha });
    // Depois de salvar, a nova senha não permanece exibida na tela.
    expect(container.textContent).not.toContain(novaSenha);
    expect(container.querySelector<HTMLInputElement>('[data-testid="vault-new-pw-v-1"]')).toBeNull();
  });

  it("revogar_sempre_permitir_chama_revoke_agent", async () => {
    vaultListMock.mockResolvedValueOnce(ENTRIES);
    vaultRevokeAgentMock.mockResolvedValueOnce({ ...ENTRIES[0], allowed_agents: [] });
    await renderVault();

    const revokeBtn = container.querySelector<HTMLButtonElement>('[data-testid="vault-revoke-v-1-tab-1"]');
    expect(revokeBtn).not.toBeNull();
    await act(async () => {
      revokeBtn!.click();
    });

    expect(vaultRevokeAgentMock).toHaveBeenCalledWith("v-1", "tab-1");
  });
});
