import { describe, expect, it } from "vitest";

import { DEFAULT_DEVICE, DEVICES, DEVICE_SCALE, deviceById, deviceNodeSize, deviceScaleOf, stepDeviceScale } from "../devices";
import { isPhoneViewport } from "../viewport";

/** O "celular solto": os modelos, o tamanho do nó e o aumentar/diminuir. */
describe("aparelhos do celular solto", () => {
  it("tem iPhone, Galaxy e Pixel, todos com tamanho de celular e ids únicos", () => {
    expect(new Set(DEVICES.map((d) => d.brand))).toEqual(new Set(["Apple", "Samsung", "Google"]));
    expect(new Set(DEVICES.map((d) => d.id)).size).toBe(DEVICES.length);
    for (const d of DEVICES) expect(isPhoneViewport(d)).toBe(true);
    expect(deviceById("iphone-15-pro-max")).toMatchObject({ width: 430, height: 932 });
    expect(deviceById("não-existe")).toBe(DEFAULT_DEVICE);
  });

  it("o nó tem o tamanho do aparelho na escala, e a escala sai de volta do tamanho do nó", () => {
    const d = deviceById("galaxy-s24");
    const box = deviceNodeSize(d, 0.8);
    expect(deviceScaleOf(d, box)).toBeCloseTo(0.8, 1);
  });

  it("aumentar e diminuir andam em passos e param nos limites", () => {
    expect(stepDeviceScale(0.75, 1)).toBe(0.85);
    expect(stepDeviceScale(0.75, -1)).toBe(0.65);
    expect(stepDeviceScale(DEVICE_SCALE.max, 1)).toBe(DEVICE_SCALE.max);
    expect(stepDeviceScale(DEVICE_SCALE.min, -1)).toBe(DEVICE_SCALE.min);
  });
});
