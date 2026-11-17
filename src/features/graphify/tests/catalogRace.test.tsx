/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  graphifyCommands: vi.fn(),
  graphifyRender: vi.fn(),
}));

vi.mock("../ipc", () => ({
  graphifyCommands: mocks.graphifyCommands,
  graphifyRender: mocks.graphifyRender,
}));
vi.mock("../send", () => ({
  agentTabs: () => [],
  runInTerminal: vi.fn(),
  sendToAgent: vi.fn(),
}));
const t = vi.hoisted(() => (key: string) => key);
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }) }));
vi.mock("neogestify-ui-components", () => ({
  AnimateSpin: () => null,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Button: ({ children, leftIcon: _l, variant: _v, size: _s, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { leftIcon?: unknown; variant?: string; size?: string }) => <button {...rest}>{children}</button>,
}));
vi.mock("@/shared/ui/PopupSelect", () => ({
  PopupSelect: (props: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
}));

import { CommandCatalog } from "../CommandCatalog";

const command = {
  id: "extract",
  group: "build",
  kind: "shell" as const,
  template: "graphify extract {backend}",
  args: [{ name: "backend", default: "neo4j", options: ["neo4j", "kuzu"] }],
  flags: [],
  longRunning: false,
};

let host: HTMLDivElement;
let root: Root;

async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); });
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.graphifyCommands.mockResolvedValue([command]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("CommandCatalog: Executar", () => {
  it("não executa o preview antigo depois de trocar um argumento", async () => {
    let hungKuzuPreview = false;
    mocks.graphifyRender.mockImplementation(async (_id: string, choice: { args: Record<string, string> }) => {
      const backend = choice.args.backend ?? "neo4j";
      const line = `graphify extract --backend ${backend}`;
      if (backend === "kuzu" && !hungKuzuPreview) {
        hungKuzuPreview = true;
        return new Promise<string>(() => { /* preview antigo ainda em voo */ });
      }
      return line;
    });

    const onRun = vi.fn().mockResolvedValue({ ok: true, code: 0, output: "" });
    await act(async () => { root.render(<CommandCatalog cwd="/tmp" onRun={onRun} />); });
    await flush();

    await act(async () => { host.querySelector("button")!.click(); });
    await flush();

    const select = host.querySelector("select")!;
    await act(async () => {
      select.value = "kuzu";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    const run = [...host.querySelectorAll("button")].find((b) => b.textContent === "settings.graphify.run")!;
    await act(async () => { run.click(); });
    await flush();

    expect(onRun).toHaveBeenCalledWith("graphify extract --backend kuzu");
    expect(onRun).not.toHaveBeenCalledWith("graphify extract --backend neo4j");
  });

  it("mostra o erro do IPC com uiErrorText quando o catálogo falha", async () => {
    mocks.graphifyCommands.mockRejectedValue({ kind: "ipc", message: "catálogo indisponível" });
    const onRun = vi.fn();
    await act(async () => { root.render(<CommandCatalog cwd="/tmp" onRun={onRun} />); });
    await flush();
    expect(host.textContent).toContain("catálogo indisponível");
  });
});
