/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ipcMock = vi.hoisted(() => ({
  memorySyncStatus: vi.fn(),
  memorySyncSetup: vi.fn(),
  memorySyncSetEnabled: vi.fn(),
  memorySyncSetAuto: vi.fn(),
  memorySyncNow: vi.fn(),
  memorySyncRestoreNow: vi.fn(),
  memorySyncResolveConflict: vi.fn(),
}));

import type { GitAccount } from "@/features/forge/types";

const forgeState = vi.hoisted(() => ({
  accounts: [
    {
      id: "acc-gh",
      kind: "github",
      host: "github.com",
      login: "tonalencar",
      name: "Ton",
      avatarUrl: null,
      auth: "oauth",
      gitUser: null,
      createdAt: 1,
      storage: "keyring",
    },
  ] as GitAccount[],
  load: vi.fn(async () => {}),
}));

const setAccountsOpen = vi.hoisted(() => vi.fn());

vi.mock("@/features/memorySync/ipc", () => ipcMock);
vi.mock("@/features/forge/store", () => ({
  useForgeStore: (sel: (s: typeof forgeState) => unknown) => sel(forgeState),
}));
vi.mock("@/app/uiStore", () => ({
  useUiStore: (sel: (s: { setAccountsOpen: typeof setAccountsOpen }) => unknown) => sel({ setAccountsOpen }),
}));
vi.mock("@/shared/openExternalUrl", () => ({
  openExternalUrl: vi.fn(async () => {}),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
    i18n: { language: "pt-BR" },
  }),
}));

import { MemorySyncCard } from "../MemorySyncCard";
import { useMemorySyncStore } from "../store";
import type { MemorySyncStatus } from "../types";

const baseStatus = (overrides: Partial<MemorySyncStatus> = {}): MemorySyncStatus => ({
  enabled: false,
  configured: false,
  accountId: null,
  repo: null,
  webUrl: null,
  autoEnabled: false,
  intervalHours: 6,
  last: null,
  lastError: null,
  ...overrides,
});

describe("MemorySyncCard", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    useMemorySyncStore.setState({ status: null, running: false, error: null });
    forgeState.accounts = [
      {
        id: "acc-gh",
        kind: "github",
        host: "github.com",
        login: "tonalencar",
        name: "Ton",
        avatarUrl: null,
        auth: "oauth",
        gitUser: null,
        createdAt: 1,
        storage: "keyring",
      },
    ];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = async (cwd = "/repo/projeto", workspaceId: string | null = "w1") => {
    await act(async () => {
      root.render(<MemorySyncCard activeCwd={cwd} workspaceId={workspaceId} />);
    });
    await act(async () => {});
  };

  it("nasce desligado por padrão e permite ligar para configurar conta e repositório ade-memoria", async () => {
    ipcMock.memorySyncStatus.mockResolvedValue(baseStatus());
    ipcMock.memorySyncSetup.mockResolvedValue(
      baseStatus({
        enabled: true,
        configured: true,
        accountId: "acc-gh",
        repo: "tonalencar/ade-memoria",
        webUrl: "https://github.com/tonalencar/ade-memoria",
      }),
    );

    await render();

    const mainSwitch = host.querySelector<HTMLButtonElement>('button[role="switch"]');
    expect(mainSwitch).not.toBeNull();
    expect(mainSwitch?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      mainSwitch!.click();
    });

    const repoInput = host.querySelector<HTMLInputElement>("input");
    expect(repoInput?.value).toBe("ade-memoria");

    const connectBtn = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("memorySync.connect"),
    );
    expect(connectBtn).toBeDefined();

    await act(async () => {
      connectBtn!.click();
    });

    expect(ipcMock.memorySyncSetup).toHaveBeenCalledWith("acc-gh", "ade-memoria");
    expect(host.textContent).toContain("tonalencar/ade-memoria");
  });

  it("exibe último envio, páginas puladas por segredo e erro, e aciona Enviar agora", async () => {
    const initial = baseStatus({
      enabled: true,
      configured: true,
      accountId: "acc-gh",
      repo: "tonalencar/ade-memoria",
      webUrl: "https://github.com/tonalencar/ade-memoria",
      autoEnabled: true,
      intervalHours: 12,
      last: {
        at: 1_700_000_000,
        restored: false,
        pushed: true,
        commit: "abcdef123456",
        aiMemoryPages: 4,
        sqliteEntries: 2,
        sqliteRevisions: 5,
        skippedPages: [
          {
            source: "ai-memory",
            path: "notes/segredo.md",
            title: "Chave antiga",
            reason: "Possível credencial ou segredo detectado",
          },
        ],
        aiMemoryNote: null,
        restore: { imported: 0, unchanged: 0, conflicts: [], skippedSecrets: 0 },
      },
      lastError: "Repositório público recusado",
    });
    ipcMock.memorySyncStatus.mockResolvedValue(initial);
    ipcMock.memorySyncNow.mockResolvedValue({
      status: { ...initial, lastError: null },
      report: initial.last!,
    });

    await render("/repo/projeto", "w1");

    expect(host.textContent).toContain("memorySync.last");
    expect(host.textContent).toContain("notes/segredo.md");
    expect(host.textContent).toContain("Chave antiga");
    expect(host.textContent).toContain("Repositório público recusado");

    const sendBtn = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("memorySync.sendNow"),
    );
    expect(sendBtn).toBeDefined();

    await act(async () => {
      sendBtn!.click();
    });

    expect(ipcMock.memorySyncNow).toHaveBeenCalledWith("w1", "/repo/projeto");
  });

  it.each([
    ["unavailable", "memorySync.warnUnavailable"],
    ["empty", "memorySync.warnEmpty"],
  ] as const)("avisa em vez de mostrar sucesso quando o ai-memory está %s", async (aiMemoryStatus, key) => {
    ipcMock.memorySyncStatus.mockResolvedValue(
      baseStatus({
        enabled: true,
        configured: true,
        accountId: "acc-gh",
        repo: "tonalencar/ade-memoria",
        last: {
          at: 1_700_000_000,
          restored: false,
          pushed: false,
          commit: null,
          aiMemoryPages: 0,
          sqliteEntries: 0,
          sqliteRevisions: 0,
          skippedPages: [],
          aiMemoryNote: null,
          aiMemoryStatus,
          restore: { imported: 0, unchanged: 0, conflicts: [], skippedSecrets: 0 },
        },
      }),
    );
    await render("", null);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(key);
  });

  it("não avisa quando páginas foram enviadas", async () => {
    ipcMock.memorySyncStatus.mockResolvedValue(
      baseStatus({
        enabled: true,
        configured: true,
        accountId: "acc-gh",
        repo: "tonalencar/ade-memoria",
        last: {
          at: 1_700_000_000,
          restored: false,
          pushed: true,
          commit: "abc1234",
          aiMemoryPages: 3,
          sqliteEntries: 0,
          sqliteRevisions: 0,
          skippedPages: [],
          aiMemoryNote: null,
          aiMemoryStatus: "ok",
          restore: { imported: 0, unchanged: 0, conflicts: [], skippedSecrets: 0 },
        },
      }),
    );
    await render();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("mostra contagens da restauração e deixa escolher uma versão para o conflito", async () => {
    const initial = baseStatus({
      enabled: true,
      configured: true,
      accountId: "acc-gh",
      repo: "tonalencar/ade-memoria",
      last: {
        at: 1_700_000_000,
        restored: false,
        pushed: false,
        commit: null,
        aiMemoryPages: 0,
        sqliteEntries: 0,
        sqliteRevisions: 0,
        skippedPages: [],
        aiMemoryNote: null,
        restore: {
          imported: 2,
          unchanged: 3,
          skippedSecrets: 1,
          conflicts: [{ path: "notas/decisao.md", remotePath: "ai-memory/default/ADE-AGS/notas/decisao.md", title: "Decisão", localBody: "local", remoteBody: "GitHub" }],
        },
      },
    });
    ipcMock.memorySyncStatus.mockResolvedValue(initial);
    ipcMock.memorySyncResolveConflict.mockResolvedValue({
      status: { ...initial, lastError: null },
      report: initial.last!,
    });
    await render();

    expect(host.textContent).toContain('"imported":2');
    expect(host.textContent).toContain("local");
    expect(host.textContent).toContain("GitHub");
    const keepLocal = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("memorySync.keepLocal"));
    await act(async () => keepLocal!.click());
    expect(ipcMock.memorySyncResolveConflict).toHaveBeenCalledWith("w1", "/repo/projeto", "ai-memory/default/ADE-AGS/notas/decisao.md", false);
  });

  it("desligar chama memorySyncSetEnabled(false) e impede envio manual", async () => {
    const connected = baseStatus({
      enabled: true,
      configured: true,
      accountId: "acc-gh",
      repo: "tonalencar/ade-memoria",
    });
    ipcMock.memorySyncStatus.mockResolvedValue(connected);
    ipcMock.memorySyncSetEnabled.mockResolvedValue({ ...connected, enabled: false });

    await render();

    const switches = host.querySelectorAll<HTMLButtonElement>('button[role="switch"]');
    expect(switches[0].getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      switches[0].click();
    });

    expect(ipcMock.memorySyncSetEnabled).toHaveBeenCalledWith(false);
    expect(host.textContent).toContain("memorySync.pausedNote");
    const sendBtn = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("memorySync.sendNow"),
    );
    expect(sendBtn?.disabled ?? true).toBe(true);
  });

  it("recusa conta forge generic ('other') sem API para confirmar privacidade", async () => {
    forgeState.accounts = [
      {
        id: "acc-other",
        kind: "other",
        host: "git.interno.local",
        login: "ton",
        name: null,
        avatarUrl: null,
        auth: "token",
        gitUser: "ton",
        createdAt: 1,
        storage: "keyring",
      },
    ];
    ipcMock.memorySyncStatus.mockResolvedValue(baseStatus());

    await render();

    const mainSwitch = host.querySelector<HTMLButtonElement>('button[role="switch"]');
    await act(async () => {
      mainSwitch!.click();
    });

    expect(host.textContent).toContain("memorySync.needApiAccount");
    expect(ipcMock.memorySyncSetup).not.toHaveBeenCalled();
  });

  it("permite ligar e ajustar intervalo de envio automático quando configurado e ativo", async () => {
    const ready = baseStatus({
      enabled: true,
      configured: true,
      accountId: "acc-gh",
      repo: "tonalencar/ade-memoria",
      autoEnabled: false,
      intervalHours: 6,
    });
    ipcMock.memorySyncStatus.mockResolvedValue(ready);
    ipcMock.memorySyncSetAuto.mockResolvedValue({ ...ready, autoEnabled: true, intervalHours: 6 });

    await render();

    const switches = host.querySelectorAll<HTMLButtonElement>('button[role="switch"]');
    expect(switches.length).toBeGreaterThanOrEqual(2);
    expect(switches[1].getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      switches[1].click();
    });

    expect(ipcMock.memorySyncSetAuto).toHaveBeenCalledWith(true, 6);
  });

  it("exibe erro de setup retornado pelo backend", async () => {
    ipcMock.memorySyncStatus.mockResolvedValue(baseStatus());
    ipcMock.memorySyncSetup.mockRejectedValue(new Error("Repositório público recusado"));

    await render();

    const mainSwitch = host.querySelector<HTMLButtonElement>('button[role="switch"]');
    await act(async () => {
      mainSwitch!.click();
    });

    const connectBtn = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("memorySync.connect"),
    );
    await act(async () => {
      connectBtn!.click();
    });

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Repositório público recusado");
  });
});
