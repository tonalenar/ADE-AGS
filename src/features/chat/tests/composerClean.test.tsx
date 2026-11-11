// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatComposer } from "../ChatComposer";
import { TeamTargetSwitch } from "../team/TeamComposer";
import { useTeamStore } from "../team/teamStore";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));

/** Um ResizeObserver de mentira que só avisa uma vez, ao observar. */
class FakeObserver {
  constructor(private cb: () => void) {}
  observe() { this.cb(); }
  disconnect() { /* nada */ }
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: FakeObserver });
  // O SnapShot e a gravação de tela só existem no macOS.
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
  useTeamStore.setState({ targets: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); vi.restoreAllMocks(); });

const mount = (props: { controls?: React.ReactNode; leading?: React.ReactNode } = {}) => act(async () => {
  root.render(<ChatComposer placeholder="p" onSubmit={() => undefined} controls={props.controls} leading={props.leading} />);
});
const left = () => host.querySelector("[data-composer-left]") as HTMLElement;
const right = () => host.querySelector("[data-composer-right]") as HTMLElement;
const more = () => host.querySelector("[data-composer-more]") as HTMLElement;

describe("o composer limpo, como o do T3 Code", () => {
  describe("rodapé", () => {
      it("à esquerda só o «+» (anexo, captura e gravação moram nele); o resto fica fora da linha", async () => {
        await mount();
        const direct = Array.from(left().children);
        expect(direct).toHaveLength(1);
        expect(direct[0]).toBe(more());
        const panel = more().querySelector("[role='group']") as HTMLElement;
        expect(panel.querySelector("button[aria-label='chat.composer.attach']")).not.toBeNull();
        expect(panel.querySelector("[data-chat-prompt-stash]")).not.toBeNull();
        expect(panel.querySelector("[data-chat-desktop-snapshot]")).not.toBeNull();
        expect(panel.querySelector("button[aria-label^='screenRecording.displayHint']")).not.toBeNull();
      });

      it("nenhuma função some: tudo segue acessível por aria-label", async () => {
        await mount({ controls: <button type="button" aria-label="modelo">m</button> });
        const labelled = (label: string) => host.querySelector(`[aria-label^='${label}']`);
        for (const label of [
          "chat.composer.moreActions", "chat.composer.attach", "screenRecording.snapshotMenu",
          "screenRecording.displayHint", "chat.stash.restore", "voiceInput", "modelo", "chat.composer.send",
        ]) {
          expect(labelled(label), label).not.toBeNull();
        }
      });

      it("à direita: controles, ditado e, por último, o enviar redondo; o ditado não está no «+»", async () => {
        await mount({ controls: <button type="button" aria-label="modelo">m</button> });
        const kids = Array.from(right().children);
        expect(kids[0]).toBe(host.querySelector("[data-composer-controls]"));
        const last = kids[kids.length - 1] as HTMLButtonElement;
        expect(last.type).toBe("submit");
        expect(last.className).toMatch(/rounded-full/);
        const voice = right().querySelector("[aria-label^='voiceInput']");
        expect(voice).not.toBeNull();
        expect(more().contains(voice)).toBe(false);
      });
  });

  it("o «Time | Só o orquestrador» deixa de ser um segmentado largo: é um chip discreto na esquerda", async () => {
    await mount({ leading: <TeamTargetSwitch orchestrator="tab-lead" /> });
    const chip = left().querySelector("[data-team-target-chip]") as HTMLButtonElement;
    expect(chip).not.toBeNull();
    expect(chip.getAttribute("aria-label")).toContain("chat.team.target.label");
    // O rótulo por extenso não ocupa a linha: some em coluna estreita (o chip fica só com o ícone).
    expect(chip.querySelector("span")!.className).toContain("@max-[30rem]/composer:sr-only");
  });

  it("as duas opções do alvo seguem acessíveis e trocam o alvo; o chip acompanha", async () => {
    await mount({ leading: <TeamTargetSwitch orchestrator="tab-lead" /> });
    const group = host.querySelector("[role='group'][aria-label='chat.team.target.label']") as HTMLElement;
    const [team, lead] = Array.from(group.querySelectorAll("button"));
    expect(team.getAttribute("aria-pressed")).toBe("true");
    await act(async () => { lead.click(); });
    expect(useTeamStore.getState().targets["tab-lead"]).toBe("lead");
    expect(lead.getAttribute("aria-pressed")).toBe("true");
    const chip = host.querySelector("[data-team-target-chip]") as HTMLElement;
    expect(chip.textContent).toContain("chat.team.target.lead");
  });
});
