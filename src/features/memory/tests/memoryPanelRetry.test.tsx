/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ipcMock = vi.hoisted(() => ({
  getWorkspaceReviewSummary: vi.fn(),
  queryMemory: vi.fn(),
  decideMemory: vi.fn(),
}));
vi.mock("../ipc", () => ipcMock);
const t = vi.hoisted(() => (key: string) => key);
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }) }));
const NO_MISSIONS = vi.hoisted(() => [] as never[]);
vi.mock("@/features/missions/store", () => ({ useMissionsStore: (sel: (s: { missions: never[] }) => unknown) => sel({ missions: NO_MISSIONS }) }));
vi.mock("../pendingStore", () => ({ usePendingMemoryStore: (sel: (s: { load: () => Promise<void> }) => unknown) => sel({ load: async () => undefined }) }));
vi.mock("../SourceCheck", () => ({ SourceCheck: () => null }));

import { MemoryPanel } from "../MemoryPanel";

let host: HTMLDivElement;
let root: Root;

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); });
}

function tabButton(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((b) => b.textContent?.startsWith(`memoryPanel.tab.${name}`));
  if (!found) throw new Error(`aba ${name} não achada`);
  return found;
}

function buttonWith(text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
}

beforeEach(async () => {
  vi.clearAllMocks();
  ipcMock.getWorkspaceReviewSummary.mockResolvedValue({ groups: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(<MemoryPanel workspaceId="w1" workspaceName="Espaço" />); });
  await flush();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("MemoryPanel: falha ao ler aprovadas/rejeitadas", () => {
  it("falha: uma consulta, sem laço; mostra a mensagem real do erro", async () => {
    ipcMock.queryMemory.mockRejectedValue({ kind: "db", message: "banco travado" });
    await act(async () => { tabButton("approved").click(); });
    await flush();
    expect(ipcMock.queryMemory).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("banco travado");
    await flush(3);
    expect(ipcMock.queryMemory).toHaveBeenCalledTimes(1);
  });

  it("só o botão Tentar de novo reconsulta", async () => {
    ipcMock.queryMemory.mockRejectedValueOnce(new Error("falhou uma vez")).mockResolvedValue({ items: [] });
    await act(async () => { tabButton("approved").click(); });
    await flush();
    expect(ipcMock.queryMemory).toHaveBeenCalledTimes(1);
    const retry = buttonWith("btn.retry");
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); });
    await flush();
    expect(ipcMock.queryMemory).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain("falhou uma vez");
  });
});
