import { comparablePath } from "@/features/tabs/viewTabs";
import { SHELL_AGENT_ID, type Tab } from "@/features/tabs/types";

/**
 * O «Rodar» dos blocos de código do chat e o terminal da conversa (a aba Terminal do painel direito). Puro, para
 * testar sem tela: qual bloco se roda, o que vai ao terminal, e qual aba de shell é a da conversa.
 */

/** As linguagens de bloco que são comando de shell. Bloco sem linguagem não se roda: pode ser saída ou texto. */
export const SHELL_LANGS: ReadonlySet<string> = new Set(["bash", "sh", "shell", "zsh", "console", "shellsession", "terminal"]);

/** A linguagem de um `className` do markdown (`language-bash`), em minúsculas; `null` sem ela. */
export function codeLang(className: string | null | undefined): string | null {
  const match = /(?:^|\s)language-([\w+-]+)/.exec(className ?? "");
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * O que «Rodar» manda ao terminal, ou `null` se o bloco não é de comando. Num bloco de sessão (`console`), só as
 * linhas de comando (`$ …`), sem o prompt; a saída que vem junto não se roda. O fim de linha final sai: o Enter é
 * do terminal.
 */
export function runnableCommand(lang: string | null, code: string): string | null {
  if (!lang || !SHELL_LANGS.has(lang)) return null;
  const text = code.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (lang === "console" || lang === "shellsession" || lang === "terminal") {
    const prompted = text.split("\n").filter((l) => /^\s*[$#] /.test(l)).map((l) => l.replace(/^\s*[$#] /, ""));
    if (prompted.length > 0) return prompted.join("\n");
  }
  return text.trim() ? text : null;
}

/** A aba de shell da pasta da conversa, se já houver (é reaproveitada, como o navegador da pasta). */
export function findShellTab(tabs: readonly Pick<Tab, "id" | "agentId" | "cwd">[], cwd: string): string | null {
  const want = comparablePath(cwd);
  return tabs.find((t) => t.agentId === SHELL_AGENT_ID && comparablePath(t.cwd) === want)?.id ?? null;
}
