/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  setEnabled: vi.fn(),
  list: vi.fn(),
  pair: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${JSON.stringify(vars)}` : k) }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: vi.fn() }));
vi.mock("@/features/tabs/store", () => ({
  useTabsStore: (sel: (s: { tabs: Array<{ cwd: string }>; activeTabId: string | null }) => unknown) =>
    sel({ tabs: [{ cwd: "/repo/ade" }], activeTabId: null }),
}));
vi.mock("../remote/ipc", () => ({
  remoteStatus: (...args: unknown[]) => mocks.status(...args),
  remoteSetEnabled: (...args: unknown[]) => mocks.setEnabled(...args),
  remoteClientsList: (...args: unknown[]) => mocks.list(...args),
  remoteClientPair: (...args: unknown[]) => mocks.pair(...args),
  remoteClientRevoke: (...args: unknown[]) => mocks.revoke(...args),
}));

import { buildClientSnippets } from "../remote/snippets";
import { RemoteAccessSettings } from "../remote/RemoteAccessSettings";

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Acesso remoto (Configurações)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.status.mockReset();
    mocks.setEnabled.mockReset();
    mocks.list.mockReset();
    mocks.pair.mockReset();
    mocks.revoke.mockReset();

    mocks.status.mockResolvedValue({
      enabled: true,
      running: true,
      port: 47820,
      tailscaleIp: "100.64.10.20",
      bindAddrs: ["127.0.0.1:47820", "100.64.10.20:47820"],
    });
    mocks.list.mockResolvedValue([]);

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("trechos_de_configuracao_tem_url_e_cabecalho", () => {
    const snippets = buildClientSnippets("100.64.10.20", 47820, "tok-super-secreto");
    expect(snippets.url).toBe("http://100.64.10.20:47820/mcp");
    expect(snippets.header).toBe("Authorization: Bearer tok-super-secreto");

    expect(snippets.claudeCode).toContain("claude mcp add --transport http ade http://100.64.10.20:47820/mcp");
    expect(snippets.claudeCode).toContain("Authorization: Bearer tok-super-secreto");

    expect(snippets.codex).toContain("[mcp_servers.ade]");
    expect(snippets.codex).toContain('url = "http://100.64.10.20:47820/mcp"');
    expect(snippets.codex).toContain("bearer_token_env_var");
    expect(snippets.codex).toContain("export ");
    expect(snippets.codex).toContain("tok-super-secreto");

    expect(snippets.t3Code.url).toBe("http://100.64.10.20:47820/mcp");
    expect(snippets.t3Code.headerValue).toBe("Bearer tok-super-secreto");
    expect(snippets.t3Code.text).toContain("http://100.64.10.20:47820/mcp");
    expect(snippets.t3Code.text).toContain("Authorization: Bearer tok-super-secreto");
  });

  it("token_aparece_uma_vez", async () => {
    const pairedClient = {
      id: "cli-1",
      name: "T3 MacBook",
      preset: "browser",
      folders: ["/repo/ade"],
      default_folder: "/repo/ade",
      created_at: 1700000000,
      expires_at: null,
      last_seen_at: null,
      revoked: false,
    };
    mocks.pair.mockResolvedValue({ client: pairedClient, token: "tok-unico-123456" });

    await act(async () => {
      root.render(<RemoteAccessSettings />);
    });
    await flush();

    const nameInput = host.querySelector<HTMLInputElement>('input[data-testid="remote-pair-name"]');
    expect(nameInput).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(nameInput, "T3 MacBook");
      nameInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const pairBtn = host.querySelector<HTMLButtonElement>('button[data-testid="remote-pair-submit"]');
    expect(pairBtn).not.toBeNull();
    await act(async () => {
      pairBtn?.click();
    });
    await flush();

    // Logo após parear, o token aparece uma vez com os trechos de configuração.
    expect(host.textContent).toContain("tok-unico-123456");
    expect(host.textContent).toContain("http://100.64.10.20:47820/mcp");

    // Ao dispensar o cartão, o token some e não aparece mais na lista de clientes.
    const dismissBtn = host.querySelector<HTMLButtonElement>('button[data-testid="remote-token-dismiss"]');
    expect(dismissBtn).not.toBeNull();
    await act(async () => {
      dismissBtn?.click();
    });
    await flush();

    expect(host.textContent).not.toContain("tok-unico-123456");
    expect(host.textContent).toContain("T3 MacBook");
  });

  it("revogar_some_da_lista", async () => {
    mocks.list.mockResolvedValue([
      {
        id: "cli-rev",
        name: "Celular antigo",
        preset: "read",
        folders: ["/repo/ade"],
        default_folder: "/repo/ade",
        created_at: 1700000000,
        expires_at: null,
        last_seen_at: 1700000100,
        revoked: false,
      },
    ]);
    mocks.revoke.mockResolvedValue(true);

    await act(async () => {
      root.render(<RemoteAccessSettings />);
    });
    await flush();

    expect(host.textContent).toContain("Celular antigo");

    const revokeBtn = host.querySelector<HTMLButtonElement>('button[data-testid="remote-revoke-cli-rev"]');
    expect(revokeBtn).not.toBeNull();
    await act(async () => {
      revokeBtn?.click();
    });
    await flush();

    expect(mocks.revoke).toHaveBeenCalledWith("cli-rev");
    expect(host.textContent).not.toContain("Celular antigo");
  });

  it("mostra_tailscale_nao_instalado_e_liga_ou_desliga_servidor", async () => {
    mocks.status.mockResolvedValue({
      enabled: false,
      running: false,
      port: 47820,
      tailscaleIp: null,
      bindAddrs: ["127.0.0.1:47820"],
    });
    mocks.setEnabled.mockResolvedValue({
      enabled: true,
      running: true,
      port: 47820,
      tailscaleIp: null,
      bindAddrs: ["127.0.0.1:47820"],
    });

    await act(async () => {
      root.render(<RemoteAccessSettings />);
    });
    await flush();

    const tsStatus = host.querySelector('[data-testid="remote-tailscale-status"]');
    expect(tsStatus?.textContent).toBe("settings.remote.tailscale.notInstalled");

    const toggle = host.querySelector<HTMLButtonElement>('button[role="switch"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      toggle?.click();
    });
    await flush();

    expect(mocks.setEnabled).toHaveBeenCalledWith(true, 47820);
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  });
});
