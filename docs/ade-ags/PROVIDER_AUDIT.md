# Auditoria de providers

Inventário do backend Rust antes de mover comportamento para o adapter, e o que a fase C fez com cada grupo. A busca foi por `agent_id`, pelos ids de fábrica (`claude-code`, `codex`, `gemini-cli`, `opencode`, `kimi-code`), `SessionSource`, `McpStyle`, `ProfileDef`, `HeadlessAgent` e os `match` em volta disso.

A meta não era zerar `match`. Parser de formato continua com a estratégia dele.

## Classes

| Classe | O que é | O que a fase C faz |
|---|---|---|
| A | Dado declarativo. Cabe na fila de `AgentDef` | Fica na fila. O adapter lê, não copia |
| B | Comportamento que muda de provider para provider | Entra no adapter, ou passa a perguntar ao adapter |
| C | Regra de produto. Não é "como este CLI funciona" | Fica onde está |
| D | Runtime genérico que carrega um id | Fica. O id é um dado da tarefa, não uma decisão |

## A — dado declarativo

| Onde | O que é |
|---|---|
| `agents/registry.rs` `AGENTS` | A tabela. Id, label, comando, flag de versão, skills, perfil, resume, `SessionSource`, `ModelSource`, `McpStyle` |
| `accounts/profiles.rs` `PROFILES` | A mesma fila, achatada para quem lê marcador de login. `default_dir` e `system_marker_root` já leem o enum, sem `_ => ~/.claude` |
| `agent_registry()` / `AgentRegistryEntry` | O que o frontend recebe. Sem campo novo nesta fase |
| `agents/detector.rs` `AgentInfo` | A fila mais o resultado do sondeo (`available`, `version`, `path`) |
| `ProfileDef` | `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`. Gemini e Kimi seguem com `profile: None` |

## B — comportamento, e para onde foi

| Onde estava | Decisão | Destino |
|---|---|---|
| `runs/agents.rs` `adapter_for` | `match` nos cinco ids para construir o `HeadlessAgent` | Cada adapter implementa `headless()`. A função da frota só chama isso |
| `agents/detector.rs` | `id == bash` para não sondear o PATH | `assumes_installed()` no adapter do shell |
| `runs/roster.rs` | Pula `bash` pelo id, e trata conta como `profile.is_some()` | Pula quem não tem headless. Conta pergunta `capabilities().accounts` |
| `accounts/store.rs` `env_for_account` | Montava `{env_var: dir}` lendo `spec_for` | `account_env`. Sem perfil, `None`. O string do diretório não é reescrito |
| `session/title.rs` `source_of` | Lia `agent_def` para escolher o parser | Lê `adapter_for`. O `match` de `SessionSource` ficou |
| `session/title.rs` e `session/export.rs` | `"opencode"` e `XDG_DATA_HOME` escritos no `Command` | Comando e variável saem da fila (`opencode_invocation`) |
| `session/export.rs` | `agent_id == "opencode"` para não procurar arquivo | `sessions == ProcessQuery`. O parser do JSON continua sendo o de OpenCode |
| `ipc/mcp.rs` `tab_browser_mcp` | Já escolhia por `McpStyle`, mas ia buscar em `agent_def` | Busca no adapter. O `match` dos dois formatos ficou |
| `runs/adapters.rs` OpenCode | Prefixo de tool com `McpStyle::OpencodeConfig` escrito à mão | Lê `mcp` da fila de OpenCode |
| `runs/mod.rs` validação de tramos | Rejeitava id fora de `agent_def` | Rejeita id fora do registro de adapters. O conjunto é o mesmo |
| `skills/links.rs` | Lia `skills_dir` e, na custom, a string da base | Pergunta `capabilities().skills` ou `custom_capabilities`. A pasta continua sendo o campo |

`HeadlessAgent` não saiu. Argv e dialeto de cada CLI continuam em `runs/agents.rs` (Claude) e `runs/adapters.rs` (os outros quatro). O adapter só aponta para essa implementação.

## B que ficou de propósito

| Onde | Por que não subiu para o trait |
|---|---|
| `session/title.rs` ramos `ClaudeProjects`, `GeminiTmp`, `CodexRollouts`, `KimiSessions`, `ProcessQuery` | São parsers. A fase B já os fez account-aware. Mover o algoritmo para o trait reescreve o módulo |
| `ipc/mcp.rs` ramos `ClaudeFlags` e `OpencodeConfig` | São os dois jeitos reais de entregar o servidor `ade-ags`. O nome do servidor não muda |
| `runs/roster.rs` `ModelSource` | Claude é lista fixa, OpenCode é `opencode models`, o resto é `Unknown`. Não há catálogo universal de preço |
| `HeadlessAgent::parse_line` | O dialeto do stream é o comportamento, e já está isolado por tipo. Um método a mais no `AgentAdapter` só encaminharia |

Um segundo provider com `ProcessQuery` ainda cairia no parser de OpenCode. Hoje só OpenCode usa essa variante. O contrato avisa: parser novo, não reuso silencioso.

## C — regra de produto

| Onde | Regra |
|---|---|
| `usage/claude.rs` | Só `claude-code` devolve consumo. As outras TUIs não gravam o dado. Devolver zero mentiria. Não há capability `usage` |
| `usage/live.rs` | O sondeo ao vivo chama o comando de `claude-code` |
| `runs/routing.rs` tramos default | Haiku, Sonnet e Opus de Claude. É o default do produto, não uma propriedade do CLI |
| `marketplace/skillssh.rs` `SKILLS_AGENT` | O catálogo skills.sh aponta para Claude |
| `graphify/targets.rs` | Pastas de instalação do graphify por plataforma. Não é `skills_dir` da fila |

## D — runtime genérico

Ficam como estão. O id viaja na tarefa, na tab, na conta ou no teste. Ninguém decide "se for Claude, faça X" nesses pontos.

- `runs/supervisor.rs` pede `adapter_for(task.agent_id)` e lança. Não conhece o CLI.
- `runs/mod.rs` repassa `task.agent_id` para skills e handoff.
- `database`, `ipc` de contas, testes e fixtures que gravam `"claude-code"` como dado de uma linha.
- `terminal/test.rs` usa a palavra `codex` dentro de um script de terminal. Não é o provider.

## TUI custom

Continua na tabela `custom_agents`. Não tem `AgentDef` estático, então não implementa `AgentAdapter`. `custom_capabilities` responde as mesmas perguntas, com conta, MCP, modelos e headless em falso. Sessões, resume e skills seguem o que o usuário preencheu. A descoberta de sessão custom continua no ramo `SessionSource::None` de `session/title.rs`.

Unificar os dois num trait só seria a fase E. Exigiria um `AgentDef` que não é `'static`, ou um segundo trait. Esta fase não cria esse segundo sistema: o registro de fábrica devolve `None` para um id custom, e quem tem o `CustomAgent` na mão pergunta as capabilities.

## O que não é capability

O navegador da app não é uma capability separada. As tools de browser viajam no servidor MCP `ade-ags`. Quem tem `mcp: false` (Codex, Gemini, Kimi, bash, custom) abre a tab sem essas tools. Quem tem `mcp: true` é Claude (`ClaudeFlags`) e OpenCode (`OpencodeConfig`).

Presença do binário também não é capability. `headless` significa "a frota tem implementação". `gemini` pode não estar no PATH e o adapter continua registrado. A detecção é que reporta `available: false`.
