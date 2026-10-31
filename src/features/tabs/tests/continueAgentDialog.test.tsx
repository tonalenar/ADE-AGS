// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentInfo, Tab } from "../types";

// @ts-expect-error Flag de act do React no happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: string, options?: Record<string, unknown>) => `${key}${options?.agent ?? ""}`,
}) }));
import { ContinueAgentDialog } from "../ContinueAgentDialog";

const source: Tab = { id: "origin", cwd: "/repo/app", title: "Origem", agentId: "codex", agentLabel: "Codex", command: "codex", ptyId: 77, openedAt: 1 };
const claude: AgentInfo = { id: "claude-code", label: "Claude", command: "claude", available: true };
const handoff = { id: "<script>not-code</script>", cwd: "/repo/app", from_agent: "codex", to_agent: "claude-code", created_at_ms: 1 };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const launch = vi.fn(async () => {});
const close = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  invoke.mockImplementation(async (name: string) => {
    if (name === "db_get_setting") return null;
    if (name === "ai_memory_handoffs") return { source: "ai-memory", trust: "UNTRUSTED", data: [handoff] };
    throw new Error(`Comando inesperado: ${name}`);
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render() {
  await act(async () => root.render(<ContinueAgentDialog source={source} claude={claude} onClose={close} onContinue={launch} />));
}
function confirm() {
  return [...document.querySelectorAll("button")].find((b) => b.textContent === "continuity.confirmClaude")!;
}
it("preview lê somente handoffs; só confirmação autoriza criar a nova aba", async () => {
  await render();
  expect(launch).not.toHaveBeenCalled();
  expect(invoke.mock.calls).toEqual([["db_get_setting", { key: "ai_memory_tabs_enabled" }], ["ai_memory_handoffs", { cwd: source.cwd }]]);
  expect(document.body.textContent).toContain(handoff.id);
  expect(document.querySelector("script")).toBeNull();
  const others = [...document.querySelectorAll("button")].filter((b) => /confirm(Codex|OpenCode)/.test(b.textContent ?? ""));
  expect(others).toHaveLength(2);
  expect(others.every((b) => b.disabled)).toBe(true);
  await act(async () => confirm().click());
  expect(launch).toHaveBeenCalledExactlyOnceWith(claude, true);
  expect(source.ptyId).toBe(77);
});
it("sem handoff abre normal, sem wrapper", async () => {
  invoke.mockImplementation(async (name: string) => name === "db_get_setting" ? null : { data: [] });
  await render(); await act(async () => confirm().click());
  expect(launch).toHaveBeenCalledExactlyOnceWith(claude, false);
});
it("opt-out não consulta ai-memory e abre normal", async () => {
  invoke.mockResolvedValue("false");
  await render(); await act(async () => confirm().click());
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(launch).toHaveBeenCalledExactlyOnceWith(claude, false);
});
it("erro de leitura bloqueia abertura e cancelar não cria PTY", async () => {
  invoke.mockRejectedValue(new Error("offline"));
  await render();
  expect(confirm().disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("offline");
  expect(launch).not.toHaveBeenCalled();
});
