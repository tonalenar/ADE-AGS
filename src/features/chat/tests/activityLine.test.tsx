// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));

import type { TurnLive } from "../activityModel";
import { ActivityLine } from "../LiveActivity";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const COMMAND = 'export PATH="$HOME/.local/bin:$PATH"; cd /tmp/e2e && ./e2e.sh J4b';

describe("a linha viva acima do composer", () => {
  it("diz só «Trabalhando…» com o tempo: o comando e o «Pensando…» já estão na timeline", async () => {
    const running: TurnLive = { startedAt: Date.now() - 65_000, tokens: null, activity: { kind: "tool", tool: "command", target: COMMAND }, recent: [], reasoning: null };
    await act(async () => { root.render(<ActivityLine live={running} startedAt={null} />); });
    const status = host.querySelector("[role='status']") as HTMLElement;
    expect(status.textContent).toContain("chat.timeline.working");
    expect(status.textContent).not.toContain("export PATH");
    expect(status.textContent).not.toContain("chat.live.command");
    expect(host.querySelector("button[aria-expanded]")?.textContent).toBe("chat.live.show");

    const thinking: TurnLive = { ...running, activity: { kind: "thinking" } };
    await act(async () => { root.render(<ActivityLine live={thinking} startedAt={null} />); });
    expect(host.textContent).not.toContain("chat.live.thinking");
  });

  it("«Ver o que está fazendo» ainda abre os últimos comandos", async () => {
    const live: TurnLive = { startedAt: null, tokens: null, activity: { kind: "thinking" }, recent: [{ id: "c1", tool: "command", label: "npm test", status: "running" }], reasoning: null };
    await act(async () => { root.render(<ActivityLine live={live} startedAt={null} />); });
    await act(async () => { (host.querySelector("button[aria-expanded]") as HTMLButtonElement).click(); });
    expect(host.textContent).toContain("npm test");
  });
});
