import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

import { simulatorDevices, type SimDevice } from "./ipc";

/** Uma linha da conversa do simulador. `user` = a pessoa; `message` = um agente falou (`ags device say`);
 *  `action` = um agente tocou, digitou ou abriu algo; `system` = o próprio simulador avisou. */
export interface SimLine {
  id: string;
  kind: "user" | "message" | "action" | "system";
  agent: string;
  text: string;
  at: number;
  /** A foto anexada (caminho do PNG). */
  shot?: string;
}

interface SimulatorState {
  devices: SimDevice[];
  loaded: boolean;
  error: string | null;
  /** A conversa de cada nó (por id do nó). Só na memória: some ao fechar o app. */
  lines: Record<string, SimLine[]>;
}

/** Quantas linhas cada conversa guarda. */
const KEEP = 200;

export const useSimulatorStore = create<SimulatorState>(() => ({ devices: [], loaded: false, error: null, lines: {} }));

let loading: Promise<void> | null = null;

/** Lê a lista de aparelhos do Xcode (com o estado de cada um). */
export function refreshDevices(): Promise<void> {
  loading ??= simulatorDevices()
    .then((devices) => useSimulatorStore.setState({ devices, loaded: true, error: null }))
    .catch((e) => useSimulatorStore.setState({ loaded: true, error: String(e) }))
    .finally(() => { loading = null; });
  return loading;
}

export function deviceByUdid(devices: SimDevice[], udid: string | undefined): SimDevice | undefined {
  return udid ? devices.find((d) => d.udid === udid) : undefined;
}

/** Marca o estado de um aparelho sem reler a lista inteira (ligou, desligou). */
export function setDeviceState(udid: string, state: SimDevice["state"]) {
  useSimulatorStore.setState((s) => ({ devices: s.devices.map((d) => (d.udid === udid ? { ...d, state } : d)) }));
}

export function addLine(node: string, line: Omit<SimLine, "id">) {
  const full: SimLine = { ...line, id: `${line.at}-${Math.random().toString(36).slice(2, 8)}` };
  useSimulatorStore.setState((s) => ({ lines: { ...s.lines, [node]: [...(s.lines[node] ?? []), full].slice(-KEEP) } }));
}

let listening = false;

/** Ouve o que os agentes fazem nos simuladores (`simulator-activity`, do backend). Uma vez por janela. */
export function listenActivity() {
  if (listening) return;
  listening = true;
  listen<{ node: string; agent: string; kind: SimLine["kind"]; text: string; at: number }>("simulator-activity", (e) => {
    const { node, agent, kind, text, at } = e.payload;
    // A mensagem da pessoa já entrou na conversa quando ela enviou.
    if (kind === "user") return;
    addLine(node, { kind, agent, text, at });
    // Um agente ligou o aparelho (`ags device start`): o nó precisa saber para mostrar a tela.
    if (kind === "action" && text.startsWith("start")) void refreshDevices();
  }).catch(() => { listening = false; });
}
