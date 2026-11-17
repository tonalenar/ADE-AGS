// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rec = vi.hoisted(() => ({ reads: 0, icons: 0 }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@/shared/useDocumentVisible", () => ({ useDocumentVisible: () => true }));
vi.mock("../tasks/taskIcons", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tasks/taskIcons")>()),
  ArrowLeftIcon: () => { rec.icons += 1; return null; },
}));
vi.mock("../tasks/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tasks/ipc")>()),
  chatTaskOutput: () => { rec.reads += 1; return Promise.resolve({ output: "build ok\n", total_bytes: 9, truncated: false }); },
}));

import type { BgTask } from "../tasks/tasksModel";
import { TaskDetail } from "../tasks/TaskDetail";

const SHELL: BgTask = {
  id: "sh1", toolUseId: null, parentId: null, kind: "shell", title: "npm run build", subagent: null, prompt: null, status: "running",
  startedAt: 1, endedAt: null, durationMs: null, summary: null, lastTool: null, background: true, stoppable: true, source: "events",
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  rec.reads = 0;
  rec.icons = 0;
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.useRealTimers();
});

describe("a saída de um shell que roda não troca o estado do detalhe quando o texto é o mesmo", () => {
  it("leituras seguidas com a mesma saída não refazem o detalhe", async () => {
    await act(async () => {
      root.render(<TaskDetail task={SHELL} threadId="thread-1" transcript={null} now={1} onBack={() => undefined} onStop={() => undefined} />);
    });
    // A primeira leitura assenta antes de começar a contar (ela é a única que muda o estado).
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain("build ok");
    rec.icons = 0;
    await act(async () => { vi.advanceTimersByTime(2000); });
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(rec.reads).toBeGreaterThanOrEqual(3);
    // Trocar o objeto de saída refaz o detalhe inteiro (os filhos também); com o mesmo texto, nada é refeito.
    expect(rec.icons).toBe(0);
  });
});
