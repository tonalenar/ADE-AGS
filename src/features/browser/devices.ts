/**
 * Os aparelhos do "celular solto": o navegador do canvas sem a janela, só o aparelho, com a página na resolução
 * dele. `width`×`height` é o viewport CSS que a página mede (o mesmo do DevTools); `radius` é o canto da tela em
 * pixels da página; `cutout` é o que tampa o topo da tela.
 */
export interface DeviceSpec {
  id: string;
  label: string;
  /** Família, para agrupar no seletor. */
  brand: "Apple" | "Samsung" | "Google";
  width: number;
  height: number;
  radius: number;
  /** `island` = Dynamic Island (iPhone); `punch` = furo da câmera (Android). */
  cutout: "island" | "punch";
}

export const DEVICES: readonly DeviceSpec[] = [
  { id: "iphone-15-pro", label: "iPhone 15 Pro", brand: "Apple", width: 393, height: 852, radius: 55, cutout: "island" },
  { id: "iphone-15-pro-max", label: "iPhone 15 Pro Max", brand: "Apple", width: 430, height: 932, radius: 55, cutout: "island" },
  { id: "iphone-15", label: "iPhone 15", brand: "Apple", width: 393, height: 852, radius: 47, cutout: "island" },
  { id: "galaxy-s24", label: "Galaxy S24", brand: "Samsung", width: 360, height: 780, radius: 34, cutout: "punch" },
  { id: "galaxy-s24-ultra", label: "Galaxy S24 Ultra", brand: "Samsung", width: 412, height: 915, radius: 14, cutout: "punch" },
  { id: "galaxy-a54", label: "Galaxy A54", brand: "Samsung", width: 384, height: 854, radius: 30, cutout: "punch" },
  { id: "pixel-8", label: "Pixel 8", brand: "Google", width: 412, height: 915, radius: 44, cutout: "punch" },
  { id: "pixel-8-pro", label: "Pixel 8 Pro", brand: "Google", width: 412, height: 892, radius: 40, cutout: "punch" },
];

export const DEFAULT_DEVICE = DEVICES[0];

/** O aparelho de um id; um id que não existe (salvo por outra versão) vira o padrão. Pura. */
export function deviceById(id: string | null | undefined): DeviceSpec {
  return DEVICES.find((device) => device.id === id) ?? DEFAULT_DEVICE;
}

/** A moldura do aparelho, em pixels de tela. */
export const DEVICE_BEZEL = 11;
/** A altura da barra flutuante acima do aparelho, em pixels do canvas. */
export const DEVICE_BAR_H = 44;

/** O tamanho do nó para mostrar o aparelho inteiro numa escala (`scale`), com a barra em cima. Pura. */
export function deviceNodeSize(device: DeviceSpec, scale: number): { w: number; h: number } {
  const pad = (DEVICE_BEZEL + 10) * 2;
  return { w: Math.round(device.width * scale + pad), h: Math.round(device.height * scale + pad + DEVICE_BAR_H) };
}

/** Os limites do "aumentar/diminuir" do aparelho, como escala da página no nó. */
export const DEVICE_SCALE = { min: 0.4, max: 1.2, step: 0.1, start: 0.75 } as const;

/** A escala em que um nó deste tamanho mostra o aparelho (a mesma conta de `deviceNodeSize`, ao contrário). Pura. */
export function deviceScaleOf(device: DeviceSpec, box: { w: number; h: number }): number {
  const pad = (DEVICE_BEZEL + 10) * 2;
  return Math.min((box.w - pad) / device.width, (box.h - pad - DEVICE_BAR_H) / device.height);
}

/** O próximo passo de escala, dentro dos limites. Pura. */
export function stepDeviceScale(current: number, direction: 1 | -1): number {
  const next = Math.round((current + direction * DEVICE_SCALE.step) * 100) / 100;
  return Math.min(DEVICE_SCALE.max, Math.max(DEVICE_SCALE.min, next));
}
