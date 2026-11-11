/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const i18nResult = { t: (k: string) => k };
vi.mock("react-i18next", () => ({ useTranslation: () => i18nResult }));

import { AUTO_SETTLE_KEY } from "@/features/chat/sidebar/autoSettlePrefs";
import { ThreadsSettings } from "../ThreadsSettings";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const optionButton = (choice: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === `settings.threads.autoSettle.option.${choice}`)!;

describe("Threads: concluir sozinho", () => {
  it("vem desligado, e escolher um prazo grava no aparelho e troca a dica", async () => {
    await act(async () => root.render(<ThreadsSettings />));
    expect(optionButton("off").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("settings.threads.autoSettle.hint.off");

    await act(async () => optionButton("7").click());
    expect(localStorage.getItem(AUTO_SETTLE_KEY)).toBe("7");
    expect(optionButton("7").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("settings.threads.autoSettle.hint.7");
  });

  it("um valor gravado por lixo volta a desligado, sem quebrar a tela", async () => {
    localStorage.setItem(AUTO_SETTLE_KEY, "para sempre");
    await act(async () => root.render(<ThreadsSettings />));
    expect(optionButton("off").getAttribute("aria-pressed")).toBe("true");
  });
});
