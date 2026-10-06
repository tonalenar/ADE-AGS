import { describe, expect, it } from "vitest";
import { CHAT_MARGIN, DEFAULT_CHAT_SIZE, MIN_CHAT_SIZE, clampSize, isDefaultSize, parseChatSize, resizeBy } from "../chatSize";

const area = { width: 1200, height: 800 };

describe("chatSize", () => {
  it("respeta minimo y maximo", () => {
    expect(clampSize({ width: 10, height: 10 }, area)).toEqual(MIN_CHAT_SIZE);
    expect(clampSize({ width: 9999, height: 9999 }, area)).toEqual({ width: 1200 - CHAT_MARGIN.x, height: 800 - CHAT_MARGIN.y });
  });
  it("area diminuta nunca baja del minimo", () => {
    expect(clampSize({ width: 500, height: 500 }, { width: 100, height: 100 })).toEqual(MIN_CHAT_SIZE);
  });
  it("arrastrar a izquierda/arriba agranda", () => {
    expect(resizeBy({ width: 400, height: 500 }, -50, -30, { left: true, top: true }, area)).toEqual({ width: 450, height: 530 });
    expect(resizeBy({ width: 400, height: 500 }, -50, -30, { left: false, top: true }, area)).toEqual({ width: 400, height: 530 });
  });
  it("lo guardado roto se ignora", () => {
    expect(parseChatSize(null)).toBeNull();
    expect(parseChatSize("{no")).toBeNull();
    expect(parseChatSize('{"width":"a","height":2}')).toBeNull();
    expect(parseChatSize('{"width":500,"height":600,"maximized":true}')).toEqual({ size: { width: 500, height: 600 }, maximized: true });
  });
  it("detecta el tamano por defecto", () => {
    expect(isDefaultSize(DEFAULT_CHAT_SIZE)).toBe(true);
    expect(isDefaultSize({ width: 500, height: 544 })).toBe(false);
  });
});
