import { useEffect, useRef, useState } from "react";

import { screenOf, sendKeysToTab } from "@/features/terminal/terminalRegistry";

import { pedidosEstaveis, promptDaTela, type PermissionChoice } from "./terminalPrompts";
import type { TerminalPromptItem } from "./teamFeedModel";

const POLL_MS = 1500;

/**
 * Os pedidos de permissão que os TUIs dos agentes estão mostrando agora (Codex, Claude Code, Gemini):
 * um por terminal. Lê a tela de cada um a cada poucos segundos. O pedido some quando o menu some
 * da tela (foi respondido, aqui ou no próprio terminal). Só olha enquanto `enabled`.
 */
export function useTerminalPrompts(tabs: { id: string; name: string }[], enabled: boolean): TerminalPromptItem[] {
  const [items, setItems] = useState<TerminalPromptItem[]>([]);
  // As chaves (aba + assinatura) vistas no tick anterior: um pedido só vira cartão se o menu continua parado.
  const seen = useRef<Set<string>>(new Set());
  const ids = tabs.map((t) => `${t.id}:${t.name}`).join("|");

  useEffect(() => {
    if (!enabled) { setItems([]); seen.current = new Set(); return; }
    let alive = true;
    const scan = () => {
      // Só o que está em modo de espera vira candidato (ver `promptDaTela`).
      const found: { key: string; tab: { id: string; name: string }; prompt: NonNullable<ReturnType<typeof promptDaTela>> }[] = [];
      for (const tab of tabs) {
        const prompt = promptDaTela(screenOf(tab.id, null, 40)?.lines);
        if (prompt) found.push({ key: `${tab.id}:${prompt.signature}`, tab, prompt });
      }
      const stable = new Set(pedidosEstaveis(seen.current, found.map((f) => f.key)));
      seen.current = new Set(found.map((f) => f.key));
      setItems((prev) => {
        const next: TerminalPromptItem[] = [];
        for (const { key, tab, prompt } of found) {
          const before = prev.find((p) => p.tabId === tab.id && p.prompt.signature === prompt.signature);
          if (before) next.push({ ...before, who: tab.name });
          else if (stable.has(key)) next.push({ tabId: tab.id, who: tab.name, prompt, atMs: Date.now() });
        }
        const same = next.length === prev.length && next.every((n, i) => prev[i]?.tabId === n.tabId && prev[i]?.prompt.signature === n.prompt.signature && prev[i]?.who === n.who);
        return same ? prev : next;
      });
    };
    if (typeof document === "undefined" || document.visibilityState !== "hidden") scan();
    let timer: number | undefined;
    const resume = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      scan();
      timer = window.setInterval(() => { if (alive) scan(); }, POLL_MS);
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", resume);
    resume();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearInterval(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", resume);
    };
    // `ids` resume a lista de terminais; `tabs` muda de identidade a cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ids]);

  return items;
}

/**
 * Responde ao menu do TUI: manda a tecla da opção. Formulários que pedem "enter to submit" (aprovação de
 * ferramenta MCP no Codex) recebem também o Enter, um instante depois. `false` se o terminal não está aberto.
 *
 * Antes da tecla, lê a tela de novo: o menu que a pessoa viu (`signature`) e a opção (`keys`) têm de ser os que
 * ainda estão lá. Se o menu mudou, sumiu ou o agente imprimiu outra coisa, nada é enviado e vale `false`.
 */
export function answerTerminalPrompt(tabId: string, choice: PermissionChoice, signature: string): boolean {
  const now = promptDaTela(screenOf(tabId, null, 40)?.lines);
  const still = now?.signature === signature && now.choices.some((c) => c.id === choice.id && c.keys === choice.keys);
  if (!still) return false;
  const needsEnter = choice.id !== "deny"
    && (screenOf(tabId, null, 30)?.lines ?? []).slice(-8).some((line) => /enter to submit/i.test(line));
  if (!sendKeysToTab(tabId, choice.keys)) return false;
  if (needsEnter) window.setTimeout(() => sendKeysToTab(tabId, "\r"), 200);
  return true;
}
