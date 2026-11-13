// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inspectPaths } from "../attachments/ipc";
import { pendingCapturePaths, rememberPendingCapture } from "../attachments/pendingCaptures";
import { useComposerCaptures } from "../attachments/useComposerCaptures";

// As chaves viram o próprio texto; a contagem aparece depois de `:` para o teste ver o plural.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: { count?: number }) => (options?.count ? `${key}:${options.count}` : key) }),
}));
vi.mock("../attachments/ipc", () => ({ inspectPaths: vi.fn() }));

interface HarnessProps {
  target: string | null;
  list: { path: string }[];
  addPaths: (paths: string[]) => Promise<boolean>;
  notify: (message: string) => void;
  onRestored?: (paths: string[]) => void;
  onRemoved?: (paths: string[]) => void;
}

function Harness(props: HarnessProps) {
  useComposerCaptures(props);
  return null;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  vi.mocked(inspectPaths).mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.clearAllMocks();
});

/** Espera as promessas da inspeção sem relógio real. */
const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});

const show = (props: HarnessProps) => act(async () => { root.render(<Harness {...props} />); });

const inspected = (path: string, error: string | null = null) => ({ path, name: path, kind: "image", mime: null, size: 1, error });

describe("capturas pendentes no composer", () => {
  it("ao montar, devolve ao rascunho as capturas que ficaram sem enviar", async () => {
    rememberPendingCapture({ path: "/a.png", target: "thread:1", kind: "snapshot" });
    vi.mocked(inspectPaths).mockResolvedValue([inspected("/a.png")] as never);
    const addPaths = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();
    await show({ target: "thread:1", list: [], addPaths, notify });
    await flush();
    expect(inspectPaths).toHaveBeenCalledWith(["/a.png"]);
    expect(addPaths).toHaveBeenCalledWith(["/a.png"]);
    expect(notify).toHaveBeenCalledWith("screenRecording.pendingRestored:1");
  });

  it("arquivo que sumiu sai do registro e avisa, para não voltar para sempre", async () => {
    rememberPendingCapture({ path: "/gone.png", target: "thread:1", kind: "snapshot" });
    vi.mocked(inspectPaths).mockResolvedValue([inspected("/gone.png", "Não encontrei o arquivo.")] as never);
    const addPaths = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();
    await show({ target: "thread:1", list: [], addPaths, notify });
    await flush();
    expect(addPaths).not.toHaveBeenCalled();
    expect(pendingCapturePaths("thread:1")).toEqual([]);
    expect(notify).toHaveBeenCalledWith("screenRecording.pendingMissing:1");
  });

  it("falha ao verificar não apaga nada e avisa", async () => {
    rememberPendingCapture({ path: "/a.png", target: "thread:1", kind: "snapshot" });
    vi.mocked(inspectPaths).mockRejectedValue(new Error("ipc caiu"));
    const notify = vi.fn();
    await show({ target: "thread:1", list: [], addPaths: vi.fn().mockResolvedValue(true), notify });
    await flush();
    expect(pendingCapturePaths("thread:1")).toEqual(["/a.png"]);
    expect(notify).toHaveBeenCalledWith("screenRecording.pendingInspectFailed");
  });

  it("tirar do rascunho (ou enviar) tira do registro a captura que saiu", async () => {
    rememberPendingCapture({ path: "/a.png", target: "thread:1", kind: "snapshot" });
    vi.mocked(inspectPaths).mockResolvedValue([inspected("/a.png")] as never);
    const addPaths = vi.fn().mockResolvedValue(true);
    await show({ target: "thread:1", list: [{ path: "/a.png" }], addPaths, notify: vi.fn() });
    await flush();
    expect(pendingCapturePaths("thread:1")).toEqual(["/a.png"]);
    await show({ target: "thread:1", list: [], addPaths, notify: vi.fn() });
    expect(pendingCapturePaths("thread:1")).toEqual([]);
  });

  it("avisa a UI para fechar o aviso quando a captura correspondente é removida", async () => {
    rememberPendingCapture({ path: "/a.png", target: "thread:1", kind: "snapshot" });
    vi.mocked(inspectPaths).mockResolvedValue([inspected("/a.png")] as never);
    const addPaths = vi.fn().mockResolvedValue(true);
    const onRestored = vi.fn();
    const onRemoved = vi.fn();
    await show({ target: "thread:1", list: [], addPaths, notify: vi.fn(), onRestored, onRemoved });
    await flush();
    expect(onRestored).toHaveBeenCalledWith(["/a.png"]);

    await show({ target: "thread:1", list: [{ path: "/a.png" }], addPaths, notify: vi.fn(), onRestored, onRemoved });
    await show({ target: "thread:1", list: [], addPaths, notify: vi.fn(), onRestored, onRemoved });
    expect(onRemoved).toHaveBeenCalledWith(["/a.png"]);
  });

  it("captura que acabou de chegar e ainda não entrou no rascunho não é apagada", async () => {
    rememberPendingCapture({ path: "/b.png", target: "thread:1", kind: "snapshot" });
    vi.mocked(inspectPaths).mockResolvedValue([inspected("/b.png")] as never);
    const addPaths = vi.fn().mockResolvedValue(true);
    await show({ target: "thread:1", list: [], addPaths, notify: vi.fn() });
    await flush();
    await show({ target: "thread:1", list: [{ path: "/a.png" }], addPaths, notify: vi.fn() });
    expect(pendingCapturePaths("thread:1")).toEqual(["/b.png"]);
  });

  it("sem conversa-alvo não consulta nem mexe no registro", async () => {
    rememberPendingCapture({ path: "/a.png", target: "thread:1", kind: "snapshot" });
    const addPaths = vi.fn();
    await show({ target: null, list: [{ path: "/a.png" }], addPaths, notify: vi.fn() });
    await show({ target: null, list: [], addPaths, notify: vi.fn() });
    await flush();
    expect(inspectPaths).not.toHaveBeenCalled();
    expect(pendingCapturePaths("thread:1")).toEqual(["/a.png"]);
  });
});
