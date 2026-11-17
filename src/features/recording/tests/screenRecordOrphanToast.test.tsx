// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: () => Promise.resolve() }));
vi.mock("@/features/chat/store", () => ({ attachToComposer: () => undefined }));

const rec = vi.hoisted(() => ({
  active: "" as string,
  started: [] as string[],
  stopped: [] as string[],
}));
vi.mock("../ipc", () => ({
  openPrivacySettings: () => Promise.resolve(),
  screenRecordingStatus: () => Promise.resolve(rec.active),
  screenRecordingStart: (_kind: string, _target: string) => {
    rec.started.push(`screen:${_target}`);
    rec.active = `screen:${_target}`;
    return Promise.resolve();
  },
  screenRecordingStop: (id: string) => {
    rec.stopped.push(id);
    rec.active = "";
    return Promise.resolve(`/tmp/${id}.mov`);
  },
}));

import { useBotToastStore } from "@/shared/brand/botToastStore";
import { ScreenRecordButton } from "../ScreenRecordButton";

let root: Root;
let host: HTMLDivElement;
const render = () => act(async () => {
  root.render(<ScreenRecordButton kind="screen" target="main" label="Tela" composerTarget="conv-1" />);
});
const orphanToasts = () => useBotToastStore.getState().toasts.filter((t) => t.sticky);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  rec.active = "";
  rec.started = [];
  rec.stopped = [];
  useBotToastStore.setState({ toasts: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("a gravação que fica sem botão tem um aviso que some quando ela para", () => {
  it("parar pelo aviso fecha o aviso; ele não para uma gravação nova", async () => {
    // Uma gravação de tela em curso quando o botão sai da tela.
    rec.active = "screen:main";
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    expect(orphanToasts()).toHaveLength(1);
    const toast = orphanToasts()[0]!;

    // Parar pelo aviso: a gravação para e o aviso some.
    await act(async () => { toast.onAction!(); await Promise.resolve(); });
    expect(rec.stopped).toEqual(["screen:main"]);
    expect(orphanToasts()).toHaveLength(0);
  });

  it("começar uma gravação nova tira o aviso antigo, que já não pode parar a nova", async () => {
    rec.active = "screen:main";
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    const stale = orphanToasts()[0]!;
    // A gravação anterior para (fora do botão) e uma nova começa pelo botão.
    rec.active = "";
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      host.querySelector("button")!.click();
      await Promise.resolve();
    });
    expect(rec.started).toEqual(["screen:main"]);
    expect(orphanToasts()).toHaveLength(0);
    // O aviso velho já não está na tela; se algo o chamar, não para a gravação nova.
    await act(async () => { stale.onAction?.(); await Promise.resolve(); });
    expect(rec.stopped).toEqual([]);
  });
});
