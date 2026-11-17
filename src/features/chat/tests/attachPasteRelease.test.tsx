// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ saved: 0, pause: false, reached: (() => undefined) as () => void, hold: (() => undefined) as (path: string) => void }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/features/terminal/ipc", () => ({
  savePastedImage: () => {
    mocks.saved += 1;
    if (mocks.pause && mocks.saved === 2) {
      mocks.reached();
      return new Promise<string>((resolve) => { mocks.hold = resolve; });
    }
    return Promise.resolve(`/tmp/pasted/${mocks.saved}.png`);
  },
}));

import { useAttachments } from "../attachments/useAttachments";

type Api = ReturnType<typeof useAttachments>;
let api: Api | null = null;
let root: Root;
let host: HTMLDivElement;
let revoke: ReturnType<typeof vi.fn>;
let urls: number;

function Harness() {
  api = useAttachments();
  return null;
}
const png = (n: number) => new File([new Uint8Array([1, 2, 3])], `foto${n}.png`, { type: "image/png" });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.saved = 0;
  mocks.pause = false;
  urls = 0;
  revoke = vi.fn();
  URL.createObjectURL = vi.fn(() => `blob:p${++urls}`);
  URL.revokeObjectURL = revoke as unknown as typeof URL.revokeObjectURL;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("a imagem colada que não entra no rascunho não deixa prévia presa", () => {
  it("a imagem que o limite de anexos recusa tem a prévia revogada; as que entraram ficam", async () => {
    await act(async () => { root.render(<Harness />); });
    const files = Array.from({ length: 11 }, (_, i) => png(i));
    await act(async () => { await api!.addFiles(files); });
    expect(api!.list).toHaveLength(10);
    expect(revoke.mock.calls).toEqual([["blob:p11"]]);
  });

  it("a tela fechada antes de a colagem terminar revoga as prévias que já estavam prontas", async () => {
    await act(async () => { root.render(<Harness />); });
    mocks.pause = true;
    const atSecond = new Promise<void>((resolve) => { mocks.reached = resolve; });
    const done = api!.addFiles([png(1), png(2)]);
    await atSecond;
    await act(async () => { root.unmount(); });
    await act(async () => { mocks.hold("/tmp/pasted/2.png"); await done; });
    expect(revoke).toHaveBeenCalledWith("blob:p1");
  });
});
