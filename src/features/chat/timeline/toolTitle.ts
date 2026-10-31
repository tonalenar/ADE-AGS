/**
 * O título de uma linha de comando ("Rodou …") na timeline: sem o invólucro do shell que o agente
 * usa (`/bin/zsh -lc "…"`), numa linha só, com o programa à parte dos argumentos. O comando inteiro
 * continua disponível em `full` (tooltip e conteúdo expandido). Sem React.
 */

export interface CommandTitle {
  /** O programa, sem a pasta (`/usr/bin/git` → `git`). */
  program: string;
  /** O resto da primeira linha útil, com os espaços colapsados. */
  rest: string;
  /** O comando inteiro, sem o invólucro do shell. */
  full: string;
  /** Um heredoc (`python3 - <<'PY'`): o corpo do script não entra no título. */
  script: boolean;
}

const SHELL_WRAPPER = /^(?:\S*[\\/])?(?:ba|z|da|fi|k)?sh(?:\.exe)?\s+-[a-z]*c\s+([\s\S]+)$/i;
const CMD_WRAPPER = /^(?:\S*[\\/])?cmd(?:\.exe)?\s+\/[cC]\s+([\s\S]+)$/;
const POWERSHELL_WRAPPER = /^(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?\s+(?:-\S+\s+)*-Command\s+([\s\S]+)$/i;

function unquote(text: string): string {
  const first = text[0];
  if ((first === '"' || first === "'") && text.length >= 2 && text.endsWith(first)) {
    const inner = text.slice(1, -1);
    return first === '"' ? inner.replace(/\\(["\\$`])/g, "$1") : inner;
  }
  return text;
}

/** Tira até dois invólucros (`bash -lc "zsh -c '…'"`). */
function unwrapShell(command: string): string {
  let text = command.trim();
  for (let i = 0; i < 2; i++) {
    const match = SHELL_WRAPPER.exec(text) ?? CMD_WRAPPER.exec(text) ?? POWERSHELL_WRAPPER.exec(text);
    if (!match) break;
    text = unquote(match[1]!.trim()).trim();
  }
  return text;
}

export function commandTitle(raw: string): CommandTitle {
  const full = unwrapShell(raw);
  const line = full.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  const script = /<<-?\s*['"]?\w+['"]?/.test(line);
  // `cd pasta && comando`: o que importa é o comando. Variáveis (`A=1 B=2 git …`) também ficam de fora.
  const afterCd = line.replace(/^cd\s+\S+\s*&&\s*/, "");
  const noEnv = afterCd.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  const head = script ? noEnv.replace(/\s*<<-?\s*['"]?\w+['"]?.*$/, "") : noEnv;
  const [first = "", ...others] = head.split(/\s+/).filter(Boolean);
  const program = first.replace(/^.*[\\/]/, "");
  // `python3 -` (script pela entrada padrão): o traço sozinho não diz nada.
  const rest = script ? others.filter((word) => word !== "-").join(" ") : others.join(" ");
  return { program, rest, full, script };
}
