/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountIdentityDialog } from "@/features/accounts/AccountIdentityDialog";
import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const conta: AgentAccount = {
  id: "system:claude-code", agentId: "claude-code", name: "Claude Code", dir: "/d", envVar: "CLAUDE_CONFIG_DIR",
  loginCommand: "claude", loggedIn: true, label: null, createdAt: 0, kind: "login", baseUrl: null, keyHint: null,
  displayName: null, accentColor: null,
};

let container: HTMLDivElement;
let root: Root;
const setIdentity = vi.fn();

beforeEach(() => {
  setIdentity.mockReset().mockResolvedValue(undefined);
  useAccountsStore.setState({ setIdentity });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const radios = () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const clicar = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

describe("diálogo de identidade da conta", () => {
  it("oferece 'sem cor' mais os 8 tokens e salva o NOME do token, não um hex", async () => {
    const onClose = vi.fn();
    await act(async () => { root.render(<AccountIdentityDialog account={conta} onClose={onClose} />); });
    expect(radios()).toHaveLength(9);
    await clicar(radios().find((r) => r.getAttribute("aria-label") === "accounts.color.green")!);
    const botao = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "settings.accounts.identity.save")!;
    await clicar(botao);
    expect(setIdentity).toHaveBeenCalledWith("system:claude-code", null, "green");
    expect(onClose).toHaveBeenCalled();
  });

  it("um erro do backend aparece e o diálogo continua aberto", async () => {
    setIdentity.mockRejectedValue("Cor desconhecida: 'x'");
    const onClose = vi.fn();
    await act(async () => { root.render(<AccountIdentityDialog account={conta} onClose={onClose} />); });
    const botao = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "settings.accounts.identity.save")!;
    await clicar(botao);
    expect(document.body.textContent).toContain("Cor desconhecida");
    expect(onClose).not.toHaveBeenCalled();
  });
});
