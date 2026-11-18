import { describe, expect, it } from "vitest";

import { captureUnlessDisposed, effectiveRecordingFps, RECORDING_FPS_CEILING } from "../recordingStart";

describe("gravação do navegador", () => {
  it("aba desmontada enquanto a foto inicial é tirada: nada é gravado (A187)", async () => {
    let mounted = true;
    // A captura é um `await`: a aba é desmontada no meio dela.
    const capture = async () => {
      mounted = false;
      return { canvas: "tela" };
    };
    expect(await captureUnlessDisposed(capture, () => !mounted)).toBeNull();
  });

  it("aba viva: a foto inicial segue para a gravação", async () => {
    expect(await captureUnlessDisposed(async () => "tela", () => false)).toBe("tela");
  });

  it("o teto de quadros por segundo é 30, e a preferência de 60 não passa dele (A204)", () => {
    expect(RECORDING_FPS_CEILING).toBe(30);
    expect(effectiveRecordingFps(60)).toBe(30);
    expect(effectiveRecordingFps(30)).toBe(30);
    expect(effectiveRecordingFps(0)).toBe(1);
  });
});
