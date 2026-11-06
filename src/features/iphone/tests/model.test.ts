import { describe, expect, it } from "vitest";

import { DEFAULT_SCREEN } from "@/features/simulator/geometry";

import {
  canTouch, deviceHint, isPhysicalId, isReady, physicalScreen, pickedPhysical, sortForPicker, statusView, type MirrorStatus, type PhysicalDevice,
} from "../model";

const phone = (over: Partial<PhysicalDevice> = {}): PhysicalDevice => ({
  id: "device:EC4D6C18-E117-53B6-8063-DB1821935BBB", name: "iPhone de Ton", model: "iPhone 15 Pro Max", os: "27.2", family: "iphone",
  transport: "wifi", paired: true, developerMode: true, tunnel: true, ...over,
});

const status = (over: Partial<MirrorStatus> = {}): MirrorStatus => ({ device: phone().id, state: "live", transport: "wifi", display: null, error: null, ...over });

describe("aparelho físico", () => {
  it("o id físico tem o prefixo e o do simulador não", () => {
    expect(isPhysicalId("device:EC4D6C18-E117-53B6-8063-DB1821935BBB")).toBe(true);
    expect(isPhysicalId("7952A8EA-BA88-45C7-A6A5-8329583BE075")).toBe(false);
    expect(isPhysicalId(undefined)).toBe(false);
    expect(isPhysicalId(null)).toBe(false);
  });

  it("pronto = tem caminho, confia no Mac e o Modo de Desenvolvedor não está desligado", () => {
    expect(isReady(phone())).toBe(true);
    expect(isReady(phone({ developerMode: null }))).toBe(true);
    expect(isReady(phone({ transport: "none" }))).toBe(false);
    expect(isReady(phone({ paired: false }))).toBe(false);
    expect(isReady(phone({ developerMode: false }))).toBe(false);
  });

  it("o aviso de cada aparelho que não está pronto diz o que falta, na ordem do que a pessoa faz", () => {
    expect(deviceHint(phone())).toBeNull();
    expect(deviceHint(phone({ transport: "none", paired: false }))).toBe("disconnected");
    expect(deviceHint(phone({ paired: false, developerMode: false }))).toBe("trust");
    expect(deviceHint(phone({ developerMode: false }))).toBe("developerMode");
  });

  it("no seletor, os prontos vêm primeiro e depois por nome", () => {
    const list = [phone({ id: "device:b", name: "b", transport: "none" }), phone({ id: "device:c", name: "Casa" }), phone({ id: "device:a", name: "aaa" })];
    expect(sortForPicker(list).map((d) => d.id)).toEqual(["device:a", "device:c", "device:b"]);
  });

  it("a tela em pontos sai dos pixels: @3x no iPhone grande, @2x no pequeno e no iPad", () => {
    expect(physicalScreen({ w: 1290, h: 2796 }, "iphone")).toEqual({ width: 430, height: 932, family: "iphone" });
    expect(physicalScreen({ w: 750, h: 1334 }, "iphone")).toEqual({ width: 375, height: 667, family: "iphone" });
    expect(physicalScreen({ w: 1640, h: 2360 }, "ipad")).toEqual({ width: 820, height: 1180, family: "ipad" });
  });

  it("sem a tela ainda, usa a moldura comum da família", () => {
    expect(physicalScreen(null, "iphone")).toEqual(DEFAULT_SCREEN);
    expect(physicalScreen(null, "ipad").family).toBe("ipad");
    expect(physicalScreen({ w: 0, h: 10 }, "iphone")).toEqual(DEFAULT_SCREEN);
  });

  it("a linha de estado: ligado com o transporte, reconectando, sem conexão e pausado", () => {
    expect(statusView(status())).toEqual({ tone: "ok", key: "iphone.status.live", transport: "iphone.transport.wifi" });
    expect(statusView(status({ state: "reconnecting", transport: "usb" }))).toEqual({ tone: "wait", key: "iphone.status.reconnecting", transport: "iphone.transport.usb" });
    expect(statusView(status({ state: "connecting", transport: null }))).toEqual({ tone: "wait", key: "iphone.status.connecting", transport: null });
    expect(statusView(status({ state: "offline" }))).toEqual({ tone: "off", key: "iphone.status.offline", transport: null });
    expect(statusView(status({ state: "paused" })).tone).toBe("off");
    expect(statusView(undefined)).toEqual({ tone: "wait", key: "iphone.status.connecting", transport: null });
  });

  it("a escolha física guardada só vale se for um id físico", () => {
    expect(pickedPhysical("device:EC4D6C18-E117-53B6-8063-DB1821935BBB")).toBe("device:EC4D6C18-E117-53B6-8063-DB1821935BBB");
    expect(pickedPhysical("lixo")).toBeNull();
    expect(pickedPhysical(null)).toBeNull();
  });

  it("só dá para tocar com o espelho ligado e o HID pronto", () => {
    expect(canTouch(status({ input: true }))).toBe(true);
    expect(canTouch(status({ input: false }))).toBe(false);
    expect(canTouch(status({ state: "reconnecting", input: true }))).toBe(false);
    expect(canTouch(undefined)).toBe(false);
  });

});

import { frameLayout, fitScale, stepZoom, ZOOM } from "../model";

describe("moldura e zoom do aparelho físico", () => {
  it("o 15 Pro Max tem o botão de ação, o volume à esquerda e o lateral à direita", () => {
    const f = frameLayout("iPhone 15 Pro Max", "iphone");
    expect(f.buttons.map((b) => `${b.side}:${b.button}`)).toEqual(["left:mute", "left:volumeUp", "left:volumeDown", "right:lock"]);
    expect(f.buttons[0].kind).toBe("action");
    expect(f.island).toBe(true);
    for (const b of f.buttons) expect(b.top + b.height).toBeLessThan(0.6);
  });

  it("modelo antigo tem a chave de silêncio no lugar do botão de ação; iPad tem só o superior e o volume", () => {
    expect(frameLayout("iPhone 14", "iphone").buttons[0].kind).toBe("switch");
    expect(frameLayout("iPhone 16e", "iphone").buttons[0].kind).toBe("action");
    expect(frameLayout("iPhone 12", "iphone").island).toBe(false);
    const ipad = frameLayout("iPad Air", "ipad");
    expect(ipad.island).toBe(false);
    expect(ipad.buttons.map((b) => b.button)).toEqual(["lock", "volumeUp", "volumeDown"]);
  });

  it("ajustar cabe na caixa; 1:1 é um pixel CSS por ponto; os passos ficam entre os limites", () => {
    const screen = { width: 430, height: 932 };
    expect(fitScale(screen, { w: 500, h: 1000 }, 0.05)).toBeCloseTo(1000 / (932 + 430 * 0.1), 5);
    expect(fitScale(screen, { w: 0, h: 0 }, 0.05)).toBe(ZOOM.min);
    expect(stepZoom(1, 1)).toBeCloseTo(1.1, 5);
    expect(stepZoom(ZOOM.max, 1)).toBe(ZOOM.max);
    expect(stepZoom(ZOOM.min, -1)).toBe(ZOOM.min);
  });
});
