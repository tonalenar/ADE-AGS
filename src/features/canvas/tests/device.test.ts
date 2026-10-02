import { describe, expect, it } from "vitest";

import { PHONE_SIZE, PORTAL_SIZE, addPortal, emptyBoard, reconcile } from "../board";
import { toDevicePoint } from "../DeviceNode";

describe("dispositivo Android en el canvas", () => {
  it("nace con forma de teléfono, se llama Android y conserva el emulador", () => {
    const base = reconcile(emptyBoard(), ["t1"]);
    const { board, name } = addPortal(base, { id: "portal-1", kind: "android", avd: "Pixel_8", near: "t1" });
    expect(name).toBe("Android");
    expect(board.portals["portal-1"]).toMatchObject({ kind: "android", avd: "Pixel_8", url: "" });
    expect(board.portals["portal-1"].box).toMatchObject(PHONE_SIZE);
    expect(board.edges).toEqual([expect.objectContaining({ a: "t1", b: "portal-1" })]);
  });

  it("un portal normal sigue siendo un navegador, sin los campos de Android", () => {
    const { board } = addPortal(emptyBoard(), { id: "portal-2", url: "https://a.b" });
    expect(board.portals["portal-2"].kind).toBeUndefined();
    expect(board.portals["portal-2"].avd).toBeUndefined();
    expect(board.portals["portal-2"].box).toMatchObject(PORTAL_SIZE);
  });

  it("dos dispositivos no se llaman igual", () => {
    const one = addPortal(emptyBoard(), { id: "portal-1", kind: "android" }).board;
    expect(addPortal(one, { id: "portal-2", kind: "android" }).name).toBe("Android 2");
  });
});

describe("del clic a la pantalla del dispositivo", () => {
  const device = { width: 1080, height: 2400 };

  it("sin franjas, escala directo", () => {
    // Caja 540x1200 (mitad): el centro de la caja es el centro del dispositivo.
    expect(toDevicePoint({ left: 100, top: 50, width: 540, height: 1200 }, device, 370, 650)).toEqual({ x: 540, y: 1200 });
    expect(toDevicePoint({ left: 100, top: 50, width: 540, height: 1200 }, device, 100, 50)).toEqual({ x: 0, y: 0 });
  });

  it("con la caja más ancha, la imagen queda centrada y las franjas no cuentan", () => {
    const box = { left: 0, top: 0, width: 1000, height: 1200 };
    // La imagen dibujada mide 540 de ancho y queda entre x = 230 y x = 770.
    expect(toDevicePoint(box, device, 100, 600)).toBeNull();
    expect(toDevicePoint(box, device, 900, 600)).toBeNull();
    expect(toDevicePoint(box, device, 500, 600)).toEqual({ x: 540, y: 1200 });
  });

  it("medidas imposibles no dan un punto", () => {
    expect(toDevicePoint({ left: 0, top: 0, width: 0, height: 10 }, device, 1, 1)).toBeNull();
    expect(toDevicePoint({ left: 0, top: 0, width: 10, height: 10 }, { width: 0, height: 0 }, 1, 1)).toBeNull();
  });
});
