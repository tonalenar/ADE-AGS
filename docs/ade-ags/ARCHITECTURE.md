# Arquitetura atual do ADE AGS, lida para a ADE AGS

Este documento descreve o ADE AGS **como ele está no fork**, no commit de upstream `632a57b` (tag de versão `1.8.7`). Não propõe a arquitetura nova. A proposta de providers está em [PROVIDER_ARCHITECTURE.md](./PROVIDER_ARCHITECTURE.md). O que muda ao longo do tempo está em [ROADMAP.md](./ROADMAP.md).

A licença do código é Apache 2.0 (`LICENSE`). O rodapé do `README.md` diz MIT. A licença que vale é o arquivo `LICENSE`.

## Forma geral

Aplicação desktop local-first. O frontend não fala com a rede da ADE. O que sai da máquina são os pedidos dos próprios agentes, o `git` do usuário e os registries de skills que ele habilitou.

```
React 19 + TypeScript + Tailwind 4 + Zustand
xterm.js · CodeMirror
        │  invoke / eventos Tauri
Rust (crate ade-ags, lib ade_ags_lib)
  terminal · runs · explorer · scm · preview
  skills · marketplace · session · agents · accounts
  usage · prelaunch · orchestrator · window
  database (SQLite) · ipc (ags + MCP) · forge · updates
```

Cada `mod.rs` do backend só declara e reexporta. A árvore de pastas é o mapa.

Dois binários saem do mesmo crate:

| Binário | Papel |
|---|---|
| `ade-ags` | A app. O nome vem de `productName` em `tauri.conf.json`. Esta versão do Tauri não expõe `mainBinaryName`. |
| `ags` | CLI. Está em `src-tauri/src/bin/cli.rs` para reusar `ipc::protocol`. |

## Frontend

Organizado por feature em `src/features/`. Cada feature concentra IPC tipado, tipos, store Zustand, componentes e testes em `tests/`. A casca (`src/app/`) é o activity rail, painéis, abas, status bar e atalhos.

O catálogo de agentes **não** é duplicado no TypeScript. `src/features/agents/registry.ts` só espelha o que `agent_registry` devolve. Isso importa: uma tab restaurada precisa do argumento de resume antes do `detect_agents`, que sonda o `PATH` e demora.

## Backend Tauri / Rust

Tauri 2. O `build.rs` chama `tauri_build::build()`. Persistência, PTY, contas e frota são código nosso (do upstream), não plugins genéricos.

Comandos Tauri cruzam a fronteira. A CLI não reimplementa essas ações: `ipc/commands/dispatch.rs` ou lê SQLite / o registro de PTYs, ou chama o mesmo comando, ou passa por `bridge` quando a fonte da verdade é o store do frontend (abrir e fechar tabs).

## PTY e terminal

`terminal/pty_manager.rs` cria um PTY com `portable-pty`. O frontend mede `cols`/`rows` antes do spawn. A saída vai ao webview por eventos `pty-data-{id}` e a uma scrollback em memória, que é o que `ags tab output` lê.

No Windows o script de prelaunch roda com `cmd /C`. No Unix, com `$SHELL -l -c`. O agente "bash" da tabela é a saída de emergência e é reportado sempre disponível, sem sondar o `PATH`, porque no Windows `bash` muitas vezes não existe. O shell real da tab no Windows é `cmd`.

Fechar a tab mata a descendência, não só o líder. No Windows isso é um Job Object (`terminal/containment.rs`, `windows-sys` 0.61). O comentário no `Cargo.toml` registra que misturar `windows-sys` 0.59 gera um binário que compila e morre com `STATUS_ENTRYPOINT_NOT_FOUND`. O pin em 0.61 não elimina as versões transitivas 0.48, 0.59 e 0.60.

## Agent registry

A tabela única de fábrica é `src-tauri/src/agents/registry.rs`, struct `AgentDef`:

| Campo | Uso |
|---|---|
| `id`, `label`, `command` | Identidade e binário no `PATH` |
| `version_flag` | Sonda de `detector.rs` (`--version`, timeout 8s, pelo caminho achado, não pelo nome: no Windows um `opencode.cmd` não executa pelo nome) |
| `skills_dir` | Pasta relativa ao projeto. Claude: `.claude/skills`. Os outros agentes de fábrica: `.agents/skills` |
| `profile` | `Option<ProfileDef>`: `env_var`, `login_command`, `marker`, `label_path`. `None` = a app não oferece várias contas |
| `resume` | Template com `{session}` |
| `sessions` | Enum `SessionSource` que escolhe o algoritmo em `session/title.rs` |
| `models` | Aliases fixos (Claude), `opencode models --verbose`, ou `Unknown` |
| `mcp` | `ClaudeFlags`, `OpencodeConfig` ou `None` |

Agentes de fábrica hoje:

| id | binário | contas | resume | sessões | MCP da app | frota headless |
|---|---|---|---|---|---|---|
| `claude-code` | `claude` | `CLAUDE_CONFIG_DIR` | `--resume {session}` | `ClaudeProjects` | flags `--mcp-config` | sim |
| `codex` | `codex` | `CODEX_HOME` | `resume {session}` (subcomando) | `CodexRollouts` | não | sim |
| `opencode` | `opencode` | `XDG_DATA_HOME` | `--session {session}` | pergunta ao processo | `OPENCODE_CONFIG_CONTENT` | sim |
| `gemini-cli` | `gemini` | não | `--resume {session}` | `GeminiTmp` em `~/.gemini` | não | sim, sem broker MCP |
| `kimi-code` | `kimi` | não | `--session {session}` | `KimiSessions` | não | sim |
| `bash` | (não sondado) | não | não | não | não | não |

TUIs custom vivem em SQLite (`custom_agents`), não na tabela. Campos: comando, `resume_args` com `{session}`, `skills_dir` relativa, `sessions_dir`, origem do id (`filename` ou `field:<chave>`), env extra. Não participam de contas múltiplas nem da frota.

## Sessões

`session/title.rs` acha o arquivo e o título. `session/export.rs` lê a conversa. Descoberta e título recebem `account_id` e resolvem o diretório da conta.

Claude, Codex e OpenCode usam esse diretório. Gemini e Kimi ignoram o argumento e leem sempre o home do sistema (`gemini_home()` → `~/.gemini`, e o equivalente do Kimi). Reabrir uma tab Gemini de uma segunda conta, quando ela existir, leria a sessão da conta errada se isso não for corrigido junto.

## Contas

Módulo `accounts/`. Uma conta é um diretório. A tab recebe uma variável de ambiente. Não há symlink do "perfil ativo": duas tabs vivas não podem dividir o mesmo arquivo de credencial.

A app cria o diretório vazio em `<app data>/accounts/<agente>/<nome>` e não lê, não copia e não grava o segredo. O login acontece no terminal do próprio agente. O que se lê do disco é só o marcador de "está logado" e, para o Claude, o email em `.claude.json` → `oauthAccount.emailAddress`.

| Agente | Variável | Diretório padrão quando a variável não está setada | Marcador de login | Onde o marcador da conta do sistema é lido |
|---|---|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` | `~/.claude` | `.claude.json` | no home, **ao lado** de `~/.claude`, não dentro |
| Codex | `CODEX_HOME` | `~/.codex` | `auth.json` | dentro de `~/.codex` |
| OpenCode | `XDG_DATA_HOME` | `$XDG_DATA_HOME` ou `~/.local/share` | `opencode/auth.json` | dentro desse data home |

`default_dir()` em `profiles.rs` tem braços só para `XDG_DATA_HOME` e `CODEX_HOME`. Qualquer outra variável cai em `~/.claude`. Ligar Gemini sem um braço próprio faria a conta do sistema apontar para a pasta do Claude.

A conta do sistema não é uma linha em `agent_accounts`. O id sintético é `system:<agent>`. As contas criadas na app são linhas. `env_for_account` devolve o mapa que o PTY e a frota já sabem injetar.

Credenciais de git do forge usam o keyring do SO (`keyring` com `windows-native`), não um arquivo de token da ADE.

## Skills

Cópia canônica em `~/.ags/skills/` (configurável). O projeto só recebe symlink, reconciliado antes de cada spawn a partir da *intenção* (skill nesta pasta ou nesta tab). Symlink que não aponta para o diretório global não é tocado.

Marketplace: GitHub, pasta local, skills.sh. Registries genéricos por git e URL de manifest JSON ainda não existem (o próprio README marca a fase 6 como incompleta).

A skill `skills/ags-orchestrator` vem no bundle e se instala sozinha.

## MCP

Hoje não há um gerenciador de servidores MCP do usuário. O que existe é o servidor MCP **da app**, nome `ade-ags`, implementado em `ipc/mcp.rs` e exposto por `ags mcp` em stdio.

Ele dá ao agente da tab: browser do projeto, orquestração da frota, conta git, pergunta ao usuário. Numa tarefa de frota ele também é o prompt de permissão (`approve_tool_use`). Se a app não responde, a resposta é não.

Só Claude (`--mcp-config` + `--strict-mcp-config`) e OpenCode (`OPENCODE_CONFIG_CONTENT`, merge) recebem esse servidor. Gemini, Codex e Kimi sobem sem essas tools. O README descreve isolamento de MCP por tab como trabalho futuro (fase 11).

## Orquestrador, frota e CLI

São três camadas que já existem e não se substituem:

1. **Tabs interativas.** `orchestrator/` comprime a saída (`digest`), guarda o cursor de leitura e oferece `watch` para não ficar em polling. O teto padrão é 3 tabs observadas.
2. **Frota.** `runs/` executa o agente sem PTY, lendo um stream JSON. Há supervisor, adapters por agente, worktree, broker de permissão, regras, roteamento por complexidade, cota, scheduler e um DAG (`run plan`). Papéis hoje: `lead` e `worker`. Fatos do run (`run_facts`) são o embrião de memória compartilhada da missão, com o aviso de que são dados, não instruções.
3. **`ags`.** TCP em loopback. O handshake fica em `~/.ags/ipc.json` (porta, token, pid, `protocol`) e numa cópia por instância em `~/.ags/ipc/<pid>.json`, apontada por `AGS_HANDSHAKE`. Autorização é o token. O arquivo precisa ser legível só pelo usuário.

Um worktree de frota vive em `~/.ags/worktrees`, ramo `cc/<task>`. Não é descartado sozinho. Descartar recusa se há mudança sem commit.

A frota já lança Gemini, Codex, OpenCode e Kimi em modo headless, não só o Claude. O que ainda é específico do Claude é o broker de permissão via MCP. O adapter Gemini (`runs/adapters.rs`) usa `--approval-mode auto_edit`, repassa `account_env` e não liga o MCP.

## Browser

`preview/` é um proxy HTTP local na frente do dev server. Injeta o seletor de elementos e deixa o WebSocket de hot reload passar. A tab de browser marca um elemento e manda ao agente o componente, o seletor e o HTML. As tools `browser_*` saem pelo mesmo MCP `ade-ags`.

## Git

`scm/` chama o `git` do usuário. `explorer/` marca status no tree. `forge/` detecta o host (GitHub, GitLab, Bitbucket, Azure, Codeberg), guarda conta no keyring e expõe tools. Worktrees de missão são os da frota, não um worktree por "missão ADE" ainda.

## Persistência local

SQLite em `~/.ags/data.db`. Schema versionado com `PRAGMA user_version` (versão 18 neste commit). Tabelas que importam para a ADE: `workspaces`, `windows`, `tabs` (inclui `account_id`, `session_id`, `prelaunch`), `skills`, `project_skills`, `custom_agents`, `session_history`, `agent_accounts`, `prelaunch_presets`, `runs`, `tasks`, `task_approvals`, `permission_rules`, `task_deps`, `run_facts`, `git_accounts`.

Nada disso é um serviço. Não há Postgres, Supabase nem Docker.

Dois roots de dados, e os dois entram em qualquer rebrand:

- `~/.ags/` — banco, skills, IPC, worktrees, runs. Caminho hardcoded em `database/connection.rs`.
- app data do Tauri, derivado do identifier `com.luis.controlcode` — contas em `accounts/`.

## O que será mantido

- Tauri 2, React, o PTY, Job Objects, SQLite local, o modelo "conta = diretório + variável de ambiente", skills por symlink, a CLI `ags` com token em loopback, a frota com worktree e permissão negada por omissão, o browser por proxy local, o git do usuário, o keyring para segredo de git.
- Os cinco agentes de fábrica e as TUIs custom. Nada disso sai para "abrir espaço".

## O que será adaptado

- `AgentDef` / `ProfileDef`, até cada provider declarar layout do home, descoberta de sessão, MCP, modelos e uso. Migração em [PROVIDER_ARCHITECTURE.md](./PROVIDER_ARCHITECTURE.md).
- `gemini_home()` e os `match` de Gemini em `session/title.rs`, para honrar o diretório da conta.
- `default_dir()` / `system_marker_root()`, para o layout do Gemini (a variável aponta para um home falso; o CLI cria `.gemini` dentro).
- Nomes, identifier, updater e pastas de dados, quando o rebrand for feito. Plano em [REBRAND.md](./REBRAND.md). Ainda não.

## O que provavelmente será substituído

- A ideia de que orquestração é só a frota atual mais a skill `ags-orchestrator`. A ADE precisa de missão, squad e handoff como objetos de primeira classe. A frota vira um executor por baixo, não o modelo de produto.
- O servidor MCP único e acoplado ao nome `ade-ags`, quando existir o MCP interno da ADE. O mecanismo (stdio, `ags mcp`, broker que nega se ninguém responde) permanece.
- Texto livre como único handoff (`run.rerouteTask` muda agente e mantém branch/worktree; não há um pacote estruturado de contexto).

## O que ainda precisa ser criado

- Layout de provider que cubra Gemini e, se existir variável verificada, Kimi.
- Multi-conta Gemini (`GEMINI_CLI_HOME`), com sessão e marcador de login no diretório certo.
- Mission Engine e Task Engine por cima de `runs`.
- Worktree por missão, não só por task da frota.
- MCP interno da ADE com attach no estilo das skills.
- Event bus explícito. Hoje o que existe são eventos Tauri, o watch da CLI e o stream da frota.
- Handoff estruturado, roles além de lead/worker, squads.
- Memória compartilhada de produto. `run_facts` é o começo, limitado ao run.
- Uso, custo e teto para todos os providers. `usage/` hoje pergunta o plano ao Claude e lê os transcripts dele.
- Map mode. Não existe vista gráfica de agentes. Maestri e Overclock são referência de produto, não de código.
