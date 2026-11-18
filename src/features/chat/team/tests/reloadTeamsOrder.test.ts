import { beforeEach, describe, expect, it, vi } from "vitest";

// A lista de times é lida do banco: o teste segura as respostas para chegarem fora da ordem em que foram pedidas.
const list = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return { ...actual, chatTeamList: list.fn };
});

import { reloadTeams, useTeamStore } from "../teamStore";

const team = (id: string) => ({ id, orchestrator: null, members: [], origin: "chat" }) as never;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  useTeamStore.setState({ teams: [], missionTeams: [], loaded: false });
});

describe("a releitura dos times não deixa uma resposta antiga voltar por cima da nova", () => {
  it("a resposta que chega depois, mas foi pedida antes, não sobrescreve a mais nova", async () => {
    const answers: ((v: unknown[]) => void)[] = [];
    list.fn.mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
    const first = reloadTeams();
    const second = reloadTeams();
    answers[1]!([team("nova")]);
    await flush();
    answers[0]!([team("antiga")]);
    await flush();
    await Promise.all([first, second]);
    expect(useTeamStore.getState().teams.map((t) => t.id)).toEqual(["nova"]);
  });
});
