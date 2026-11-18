// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: () => Promise.resolve() }));
vi.mock("@/features/chat/store", () => ({ attachToComposer: () => undefined }));

// O backend: uma gravação por fonte. A parada pode demorar (o teste segura a resposta com `gate`).
const rec = vi.hoisted(() => ({
  active: "" as string,
  gate: null as null | Promise<void>,
  stopped: [] as string[],
  started: [] as string[],
}));
vi.mock("../ipc", () => ({
  openPrivacySettings: () => Promise.resolve(),
  screenRecordingStatus: () => Promise.resolve(rec.active),
  screenRecordingStart: (kind: string, target: string) => {
    rec.started.push(`${kind}:${target}`);
    rec.active = `${kind}:${target}`;
    return Promise.resolve();
  },
  screenRecordingStop: (id: string) => {
    rec.stopped.push(id);
    const gate = rec.gate ?? Promise.resolve();
    return gate.then(() => { rec.active = ""; return `/tmp/${id}.mov`; });
  },
}));

import { useBotToastStore } from "@/shared/brand/botToastStore";
import { ScreenRecordButton } from "../ScreenRecordButton";

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const mount = () => act(async () => { root.render(<ScreenRecordButton kind="desktop" target="main" label="Tela" composerTarget="conv-1" />); });
const unmount = () => act(async () => { root.unmount(); });
const button = () => host.querySelector("button") as HTMLButtonElement;
const orphanToasts = () => useBotToastStore.getState().toasts.filter((t) => t.sticky);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // A gravação da tela principal é do macOS (o botão só aparece lá).
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
  rec.active = "";
  rec.gate = null;
  rec.stopped = [];
  rec.started = [];
  useBotToastStore.setState({ toasts: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { host.remove(); vi.restoreAllMocks(); });

describe("duas gerações da mesma tela não se confundem no aviso que fica", () => {
  it("parar_a_geracao_antiga_nao_tira_o_aviso_da_nova: a parada da geração 1 termina depois de a 2 começar; o aviso da 2 fica", async () => {
    // Geração 1 em curso; o botão sai da tela e o aviso fica.
    rec.active = "desktop:main";
    await mount();
    await flush();
    await unmount();
    root = createRoot(host);
    const first = orphanToasts()[0]!;
    expect(first).toBeDefined();

    // Parar pelo aviso: a resposta do backend demora.
    let release: () => void = () => undefined;
    rec.gate = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => { first.onAction!(); await flush(); });
    expect(rec.stopped).toEqual(["desktop:main"]);

    // Enquanto a geração 1 ainda para, a geração 2 começa pelo botão e sai da tela com o seu aviso.
    rec.active = "";
    await mount();
    await flush();
    await act(async () => { button().click(); await flush(); });
    expect(rec.started).toEqual(["desktop:main"]);
    await unmount();
    root = createRoot(host);
    const second = orphanToasts().find((t) => t.id !== first.id);
    expect(second).toBeDefined();

    // A parada da geração 1 termina agora: o aviso da geração 2 não pode sumir com ela.
    await act(async () => { release(); await flush(); });
    expect(orphanToasts().map((t) => t.id)).toContain(second!.id);
  });
});
