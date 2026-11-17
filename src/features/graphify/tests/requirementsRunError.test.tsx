/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ graphifyRequirements: vi.fn() }));
vi.mock("../ipc", () => ({ graphifyRequirements: mocks.graphifyRequirements }));
const t = vi.hoisted(() => (key: string) => key);
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }) }));
vi.mock("neogestify-ui-components", () => ({
  AnimateSpin: () => null,
  CheckCircleIcon: () => null,
  Input: () => null,
  Button: ({ children, leftIcon: _l, variant: _v, size: _s, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { leftIcon?: unknown; variant?: string; size?: string }) => <button {...rest}>{children}</button>,
}));
vi.mock("@/shared/openExternalUrl", () => ({ openExternalUrl: vi.fn() }));

import { RequirementsBlock } from "../RequirementsBlock";

let host: HTMLDivElement;
let root: Root;

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); });
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.graphifyRequirements.mockResolvedValue([{
    id: "uv", command: "uv", docsUrl: "https://docs.example", version: null, install: "uv tool install graphifyy", otherInstalls: [],
  }]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("RequirementsBlock: falha ao rodar um requisito", () => {
  it("mostra a mensagem do erro, não [object Object]", async () => {
    const onRun = vi.fn().mockRejectedValue({ kind: "proc", message: "sem permissão" });
    await act(async () => { root.render(<RequirementsBlock onRun={onRun} running={false} />); });
    await flush();
    const run = [...host.querySelectorAll("button")].find((b) => b.textContent === "settings.graphify.run");
    expect(run).toBeDefined();
    await act(async () => { run!.click(); });
    await flush();
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(host.querySelector("pre")?.textContent).toBe("sem permissão");
  });
});
