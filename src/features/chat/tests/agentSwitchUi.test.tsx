// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key}${JSON.stringify(o)}` : key), i18n: { language: "pt-BR" } }),
}));

import { AgentSwitchDialog } from "../structured/AgentSwitchDialog";
import { lacksApproval, switchableAgents } from "../structured/switchModel";
import { NoticeRow } from "../timeline/NoticeRow";
import type { TimelineItem } from "../timeline/types";

const agent = (id: string, label: string, available = true) => ({ id, label, command: id, available }) as never;

describe("quais agentes aparecem para trocar", () => {
  const detected = [agent("claude-code", "Claude Code"), agent("codex", "Codex"), agent("gemini-cli", "Gemini"), agent("opencode", "OpenCode", false), agent("antigravity", "Antigravity"), agent("bash", "Terminal")];

  it("só os que conversam por protocolo e estão instalados, com o da conversa primeiro", () => {
    expect(switchableAgents(detected, "codex").map((a) => a.id)).toEqual(["codex", "claude-code", "antigravity"]);
  });

  it("o agente da conversa aparece mesmo que a detecção ainda não o tenha (nunca fica sem o atual)", () => {
    expect(switchableAgents([], "codex", "Codex").map((a) => a.id)).toEqual(["codex"]);
  });
});

describe("a confirmação da troca", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); document.body.innerHTML = ""; });

  it("diz para quem troca, o que o novo agente recebe e o que se perde, e só troca ao confirmar", async () => {
    const calls: string[] = [];
    await act(async () => { root.render(<AgentSwitchDialog from="Claude Code" to="Codex" busy={false} error={null} onConfirm={() => calls.push("ok")} onClose={() => calls.push("fecha")} />); });
    const text = document.body.textContent ?? "";
    expect(text).toContain('chat.agentSwitch.title{"agent":"Codex"}');
    expect(text).toContain("chat.agentSwitch.body");
    expect(text).toContain('chat.agentSwitch.loss{"from":"Claude Code"}');
    expect(calls).toEqual([]);
    const confirm = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes("chat.agentSwitch.confirm"))!;
    await act(async () => { confirm.click(); });
    expect(calls).toEqual(["ok"]);
  });

  it("enquanto troca o botão fica desligado, e um erro aparece como alerta (a conversa não muda)", async () => {
    await act(async () => { root.render(<AgentSwitchDialog from="Claude Code" to="Codex" busy error="Espere o agente terminar o turno" onConfirm={() => undefined} onClose={() => undefined} />); });
    const confirm = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes("chat.agentSwitch.busy")) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(document.body.querySelector("[role=alert]")?.textContent).toContain("Espere o agente terminar o turno");
  });

  it("o aviso do fio diz «agora com Codex · modelo» e o que o agente novo recebeu", async () => {
    const item = (strategy: string, accessChanged = false): TimelineItem => ({ kind: "notice", id: "n", label: "agentSwitch", text: JSON.stringify({ from: "claude-code", to: "codex", fromLabel: "Claude Code", toLabel: "Codex", model: "gpt-6.1-sol", strategy, accessChanged }) });
    await act(async () => { root.render(<NoticeRow item={item("full")} />); });
    expect(host.textContent).toContain('chat.timeline.notice.agentSwitchModel{"agent":"Codex","model":"gpt-6.1-sol"}');
    expect(host.textContent).toContain("chat.timeline.notice.agentSwitchFull");
    expect(host.textContent).not.toContain("agentSwitchAccess");
    await act(async () => { root.render(<NoticeRow item={item("delta", true)} />); });
    expect(host.textContent).toContain("chat.timeline.notice.agentSwitchDelta");
    expect(host.textContent).toContain("chat.timeline.notice.agentSwitchAccess");
  });
});

describe("o Antigravity não tem tela de aprovação", () => {
  it("só ele, e só no acesso Supervisionado", () => {
    expect(lacksApproval("antigravity", "ask")).toBe(true);
    expect(lacksApproval("antigravity", "edits")).toBe(false);
    expect(lacksApproval("codex", "ask")).toBe(false);
    expect(lacksApproval("claude-code", "ask")).toBe(false);
  });

  it("a confirmação avisa antes de trocar, e o aviso do fio repete depois", async () => {
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    await act(async () => { root.render(<AgentSwitchDialog from="Claude Code" to="Antigravity" busy={false} error={null} noApproval onConfirm={() => undefined} onClose={() => undefined} />); });
    expect(document.body.textContent).toContain('chat.agentSwitch.noApproval{"agent":"Antigravity"}');
    await act(async () => { root.render(<NoticeRow item={{ kind: "notice", id: "n", label: "agentSwitch", text: JSON.stringify({ from: "claude-code", to: "antigravity", fromLabel: "Claude Code", toLabel: "Antigravity", model: null, strategy: "full", accessChanged: false, noApproval: true }) }} />); });
    expect(document.body.textContent).toContain("chat.timeline.notice.agentSwitchNoApproval");
    await act(async () => { root.unmount(); });
  });
});

