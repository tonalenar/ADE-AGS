# Contrato de provider

Como a ADE escolhe o comportamento de uma TUI sem espalhar `if agent == "..."`. A fase C está no código. A fase D (conta de Gemini) e a fase E (custom dentro do mesmo trait) não estão.

O desenho que um Mission Engine futuro deve poder usar, e que esta fase deixa preparado sem implementar o engine:

```text
provider = registry.get(task.provider)
if !provider.capabilities.headless:
    reject
agent = fleet.spawn(provider, account, worktree, task)
```

No código de hoje isso é:

```text
let provider = agents::adapter_for(task.agent_id)?;
if !provider.capabilities().headless {
    // a frota recusa: runs::agents::adapter_for devolve None
}
let agent = provider.headless()?;
// supervisor::start já faz isso a partir do agent_id da tarefa
```

`HeadlessAgent` continua sendo o processo: argv, ambiente, parse do stream, resultado. O adapter não o substitui.

```text
AgentDef          dados da TUI de fábrica
   +
AgentAdapter      comportamento que não cabe na fila
   ↓
registro          agents::adapter_for / agents::adapters
   ↓
runtime           detecção, contas, sessões, MCP, roster, frota
```

## AgentDef

`src-tauri/src/agents/registry.rs`. Uma linha por TUI de fábrica.

| Campo | Papel |
|---|---|
| `id`, `label` | Identidade estável. O frontend e o SQLite usam o `id` |
| `command`, `version_flag` | Binário no PATH e como perguntar a versão |
| `skills_dir` | Pasta relativa ao projeto. `None` = a app não gere skills |
| `profile` | `Some` só com isolamento verificado. `None` = sem multi-conta |
| `resume` | Argumentos com `{session}`. `None` = não reabre por id |
| `sessions` | Qual parser de `session/title.rs` usar |
| `models` | Lista fixa, pergunta ao CLI, ou `Unknown` |
| `mcp` | Como o servidor `controlcode` entra. O nome do servidor não muda |

A fila não ganha métodos. Ícone continua no React, escolhido pelo mesmo `id`.

## AgentAdapter

`src-tauri/src/agents/adapter.rs`. Trait pequeno, object-safe, implementado por unit structs estáticos. `adapter_for` não aloca. `headless()` aloca o `HeadlessAgent` só quando a frota lança uma corrida, que já alocava antes.

Métodos que existem porque o comportamento muda:

| Método | O que faz | Default |
|---|---|---|
| `def()` | A fila. Única ponte para os dados | obrigatório |
| `has_headless()` / `headless()` | Se a frota sabe lançar, e o objeto da corrida | `false` / `None` |
| `assumes_installed()` | Reportar instalado sem olhar o PATH | `false`. Só bash devolve `true` |
| `account_env(dir)` | `{variável: diretório}` ou `None` | Lê `profile`. Sem perfil, `None` |
| `capabilities()` | O que está implementado de verdade | Derivado. Não se preenche à mão |

Não há método `session_source()`, `command()` ou `mcp_style()`. Isso é campo da fila. Quem precisa lê `def()`.

Não há plugin, WASM, DLL, marketplace de providers nem provider remoto.

## Capabilities

Derivadas. Uma capability futura fica `false`.

| Campo | Verdadeiro quando |
|---|---|
| `accounts` | `profile` é `Some` |
| `sessions` | `sessions` não é `None` |
| `resume` | `resume` é `Some` |
| `skills` | `skills_dir` é `Some` |
| `mcp` | `mcp` não é `None` |
| `models` | `models` não é `Unknown` |
| `headless` | existe `HeadlessAgent` |

O browser da app não é um campo. Entra junto com o MCP.

| Provider | Accounts | Sessions | Resume | MCP | Headless | Skills | Models |
|---|---|---|---|---|---|---|---|
| Claude Code | sim | sim | sim | sim, flags | sim | `.claude/skills` | aliases |
| Codex | sim | sim | sim | não | sim | `.agents/skills` | não |
| Gemini CLI | não | sim | sim | não | sim | `.agents/skills` | não |
| OpenCode | sim | sim, via processo | sim | sim, config | sim | `.agents/skills` | pergunta ao CLI |
| Kimi Code | não | sim | sim | não | sim | `.agents/skills` | não |
| Terminal (bash) | não | não | não | não | não | não | não |

Gemini está na tabela mesmo sem o binário `gemini` nesta máquina. `headless: sim` quer dizer que o código de lançamento existe. A detecção é que responde se o executável está no PATH. Conta continua desligada: `account_env` devolve `None` e não emite `CLAUDE_CONFIG_DIR`.

## Registro

```text
agents::adapters()      os seis, na ordem da fila
agents::adapter_for(id) Option<&'static dyn AgentAdapter>
```

Id desconhecido, inclusive uma TUI custom e um provider que ainda não foi adicionado (`qwen-code`), devolve `None`. Não há ids repetidos: o teste `el_registro_no_repite_ids_y_cubre_el_catalogo` trava a tabela contra `AGENTS`.

A frota não tem um segundo catálogo. `runs::agents::adapter_for` é só `agents::adapter_for(id)?.headless()`.

## Contas

O comportamento não mudou.

| Provider | Variável | Home default |
|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` | `~/.claude`. O marcador de sistema fica no home, ao lado |
| Codex | `CODEX_HOME` | `~/.codex` |
| OpenCode | `XDG_DATA_HOME` | `XDG_DATA_HOME` ou `~/.local/share` |
| Gemini CLI | nenhuma | `profile: None` |
| Kimi Code | nenhuma | `profile: None` |

`env_for_account` pede o mapa ao adapter. Ligar Gemini no futuro é preencher `ProfileDef` na fila, depois de um ensaio real com o binário. Os call sites que já usam `account_env` não precisam de um `if gemini`.

## Sessões

A escolha da estratégia é a fila (`SessionSource`). Os parsers continuam em `session/title.rs`:

| Variante | Parser | Conta |
|---|---|---|
| `ClaudeProjects` | jsonl em `projects/` | diretório do perfil |
| `CodexRollouts` | rollouts | diretório do perfil |
| `GeminiTmp` | `tmp/<slug>/chats` | sem perfil, `~/.gemini`; com diretório, `<dir>/.gemini` |
| `KimiSessions` | `sessions/` | sem perfil, `KIMI_CODE_HOME` ou `~/.kimi-code`; com diretório, `<dir>/sessions` |
| `ProcessQuery` | `opencode session list` / `opencode export` | variável da fila, hoje `XDG_DATA_HOME` |
| `None` | TUI custom, se o usuário declarou a pasta | não se aplica |

`profile: None` em Gemini não impede o parser de existir. Impede a app de oferecer uma segunda conta.

## Headless e frota

```text
Mission Engine   não existe ainda
    ↓
AgentAdapter     capabilities + headless()
    ↓
HeadlessAgent    argv, env, parse, finish
    ↓
supervisor       processo, jsonl, cancelamento, worktree
```

O supervisor continua a receber uma tarefa com `agent_id`, conta, cwd e prompt. Não aprendeu os nomes dos CLIs. Worktree, orçamento e reroute também não.

Quem não tem headless (bash, custom, id desconhecido) não entra no roster e `supervisor::start` responde que ainda não sabe correr aquele id sem terminal.

## TUI custom

Estratégia desta fase, sem segunda arquitetura permanente:

- de fábrica: `AgentAdapter` estático, ligado a um `AgentDef`;
- custom: fora do registro. `custom_capabilities` lê a linha do SQLite.

Conta, MCP, modelos e headless de uma custom ficam falsos até a fase E. Sessão, resume e skills respeitam o formulário. String em branco conta como não configurado. A descoberta continua em `session/title.rs` no ramo `None`, com o `CustomAgent` que o chamador já resolveu para não reentrar no lock.

A fase E é que pode fazer a custom implementar o mesmo contrato. Não agora: `def()` devolve `&'static AgentDef`, e uma custom não tem essa fila.

## Detecção

`detect_agents` percorre `adapters()` na ordem da fila. Para cada um, procura `command` e corre `version_flag`, com timeout. Bash não é procurado: `assumes_installed` o reporta disponível e sem versão. O payload `AgentInfo` que o frontend já consumia não ganhou campo.

O registro não depende do binário estar instalado.

## Como adicionar `qwen-code`

1. Confirmar, fora da ADE, o binário, o resume, onde ficam as sessões, se existe variável de conta isolada, como entra um MCP e como se listam modelos. O que não foi verificado fica `None` ou `Unknown`. Não marcar capability por documentação não testada.
2. Acrescentar uma linha em `AGENTS`. Sem essa linha o resto não compila nos pontos que exigem a fila, e o teste do catálogo falha se o adapter não acompanhar.
3. Se a conta foi isolada de verdade, preencher `ProfileDef` (`env_var`, marcador, `DefaultHome`, `SystemMarkerRoot`). `account_env` passa a devolver o mapa. Sem ensaio, deixar `profile: None`.
4. Se o formato de sessão for novo, criar uma variante de `SessionSource` e um parser em `session/title.rs`. Não colocar o parser no trait.
5. Se a frota for lançá-lo, implementar `HeadlessAgent` ao lado dos outros em `runs/` (argv e parse do stream) e um unit struct em `adapter.rs` com `has_headless` e `headless`. Sem frota, o default `None` basta: o roster não o oferece.
6. Se o MCP for um dos dois estilos existentes, apontar `mcp` para ele. Um terceiro estilo é um ramo novo em `ipc/mcp.rs`, não um `if qwen`. O servidor continua `controlcode`.
7. Modelos: `Aliases` se a lista for fixa e verificada, um variante novo de `ModelSource` se houver que perguntar ao CLI, ou `Unknown`.
8. Registrar o unit struct no slice `ADAPTERS`, na mesma ordem da linha.
9. Acrescentar um teste em `agents/contract.rs` no formato dos outros: id, comando, capabilities, ambiente de conta, e que um id desconhecido continua de fora.
10. Ícone, se for aparecer na UI, em `agentIcons.tsx`, pelo mesmo `id`. Não há segunda tabela no frontend.

Não criar um loader dinâmico para esse passo. Um provider novo é código no binário, revisado como o resto.
