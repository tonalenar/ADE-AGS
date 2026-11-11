/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const i18nResult = { t: (k: string) => k };
vi.mock("react-i18next", () => ({ useTranslation: () => i18nResult }));

const fake = vi.hoisted(() => ({
  title: { enabled: false, instructions: "", agentId: null as string | null, model: null as string | null },
  resume: false,
  calls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  failTitleSave: "" as string,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    fake.calls.push({ cmd, args });
    switch (cmd) {
      case "chat_title_settings_get": return { ...fake.title };
      case "chat_title_settings_set":
        if (fake.failTitleSave) throw new Error(fake.failTitleSave);
        fake.title = { ...(args.settings as typeof fake.title) };
        return { ...fake.title };
      case "chat_title_writers": return ["claude-code", "codex"];
      case "chat_limit_resume_pref_get": return fake.resume;
      case "chat_limit_resume_pref_set": fake.resume = args.enabled as boolean; return null;
      default: throw new Error(`comando inesperado: ${cmd}`);
    }
  }),
}));

vi.mock("@/features/agents/useAvailableAgents", () => ({
  useAvailableAgents: () => [{ id: "codex", label: "Codex" }, { id: "claude-code", label: "Claude Code" }],
}));

import { ThreadsTextSettings } from "../ThreadsTextSettings";

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  fake.title = { enabled: false, instructions: "", agentId: null, model: null };
  fake.resume = false;
  fake.calls.length = 0;
  fake.failTitleSave = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<ThreadsTextSettings />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const switchFor = (label: string) => {
  const span = [...container.querySelectorAll("span")].find((el) => el.id !== "" && el.textContent === label)!;
  return container.querySelector(`[role=switch][aria-labelledby="${span.id}"]`) as HTMLButtonElement;
};
const setValue = (el: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("Threads: título por modelo e retomada após o limite", () => {
  it("os dois vêm desligados, com o que o backend tem", async () => {
    expect(switchFor("settings.threads.title.enable").getAttribute("aria-checked")).toBe("false");
    expect(switchFor("settings.threads.limit.resume").getAttribute("aria-checked")).toBe("false");
  });

  it("ligar o título grava, mantendo as instruções", async () => {
    const area = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => setValue(area, "até 50 caracteres"));
    await act(async () => area.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    await act(async () => switchFor("settings.threads.title.enable").click());
    expect(fake.title).toMatchObject({ enabled: true, instructions: "até 50 caracteres" });
  });

  it("as instruções gravam ao sair do campo, e só se mudaram", async () => {
    const area = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => setValue(area, "comece com o número da tarefa"));
    await act(async () => area.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(fake.title.instructions).toBe("comece com o número da tarefa");
    expect(container.textContent).toContain("29/600");

    fake.calls.length = 0;
    await act(async () => area.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(fake.calls.filter((c) => c.cmd === "chat_title_settings_set")).toHaveLength(0);
  });

  it("o agente que escreve o título vem dos que rodam somente leitura, e trocar zera o modelo", async () => {
    const select = [...container.querySelectorAll("select")].find((el) => el.getAttribute("aria-label") === "settings.threads.title.writer")!;
    expect([...select.options].map((o) => o.value)).toEqual(["", "claude-code", "codex"]);
    await act(async () => { select.value = "codex"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(fake.title).toMatchObject({ agentId: "codex", model: null });
    const model = container.querySelector("input[aria-label=\"settings.threads.title.model\"]") as HTMLInputElement;
    await act(async () => setValue(model, "gpt-6.1-sol"));
    await act(async () => model.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(fake.title).toMatchObject({ agentId: "codex", model: "gpt-6.1-sol" });
  });

  it("o erro do backend aparece e a tela segue com o que estava", async () => {
    fake.failTitleSave = "As instruções do título passam de 600 caracteres";
    await act(async () => switchFor("settings.threads.title.enable").click());
    expect(container.querySelector("[role=alert]")?.textContent).toContain("passam de 600");
    expect(fake.title.enabled).toBe(false);
  });

  it("retomar depois do limite grava a preferência", async () => {
    await act(async () => switchFor("settings.threads.limit.resume").click());
    expect(fake.resume).toBe(true);
    expect(switchFor("settings.threads.limit.resume").getAttribute("aria-checked")).toBe("true");
  });
});
