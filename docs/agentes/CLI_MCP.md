# CLI `ags`, MCP e dados em disco

> Parte do guia de agentes. Índice e regras de ouro: [`AGENTS.md`](../../AGENTS.md).

## Regras para quem usa a CLI
- Para pilotar o app, siga a skill **[`skills/ags-orchestrator/SKILL.md`](../../skills/ags-orchestrator/SKILL.md)**.
- Olhe antes de criar: `ags workspace status`, `ags peers`, `ags agents`, `ags accounts`.
- Informe ao usuário os ids das abas que você abriu.
- **Nunca faça polling.** Use `ags watch add/wait` ou `ags events wait`.
- Observe no máximo 3 abas. Comandos longos vão numa aba de terminal (`--agent bash`).
- Aba que você não abriu é do usuário.
- Exit codes:
  - 0: ok;
  - 1: o comando falhou (leia `.error`);
  - 2: erro de uso;
  - 3: o app não está rodando (pare e peça ao usuário para abri-lo).

## Protocolo
- Uma linha JSON `{token, command: "grupo.ação", args}` → `{ok, data, error}` (`ipc/protocol.rs`, `PROTOCOL_VERSION = 1`).
- Transporte: TCP em `127.0.0.1`, numa porta aleatória.
  - O handshake fica em `~/.ags/ipc.json` (global) e em `~/.ags/ipc/<pid>.json`.
  - Os filhos herdam `AGS_HANDSHAKE`.
  - No Windows, um named pipe por PID (`\\.\pipe\ags-ipc-<pid>`) identifica o processo chamador.
- Limites: 256 conexões e 8 MB por request. O token é comparado em tempo constante.
- `memory.*` e `swarm.*` exigem `ADE_SESSION` e que o processo seja descendente do PTY da aba (`terminal/session.rs::authorize`).
- `memory.compact` e `workspace.restore` são negados a agentes (`AGENT_MAINTENANCE_DENIED`): só pela UI.
- `ADE_TAB_ID` identifica quem chama, mas **não é segurança**.
- A saída é sempre uma linha JSON no stdout; ajuda e erros de uso vão para o stderr.

## Grupos de comando
`tab`, `peer(s)`, `portal(s)`/`open`, `say`/`recall`, `routine(s)`, `floor(s)`, `role(s)`, `note(s)`, `design`, `watch`, `events`, `mission`, `worktrees`, `approval`, `memory`, `swarm`, `window`, `workspace`, `run`, `browser run`, `agents`, `accounts`, `pool(s)`, `prelaunch`, `skills`/`skill`, `device(s)` (Android), `ci watch`, `test` (roda local, sem o app), `app status`, `mcp`.

Flags globais: `--version` e `--json-args '{…}'`. Uma URL `http…` solta vira `portal.open`, porque o app define `BROWSER=ags`.

## Comando novo
1. Escreva o handler em `ipc/commands/<x>.rs`, retornando `Result<serde_json::Value, String>`. Leia os argumentos com `arg_str`, `arg_str_opt`, `arg_u64_checked`.
2. Acrescente o braço no `match` de `ipc/commands/dispatch.rs`.
3. Em `bin/cli.rs`, escreva o USAGE (em PT-BR) e os `positionals()`. Se o comando precisar da identidade da aba, inclua o grupo em `with_caller()`; atalhos de uma palavra ficam em `shortcut()`.
4. Se o comando vier por MCP, mexa em `ipc/mcp.rs` (e em `runs/orchestration.rs`). Se só o front sabe executá-lo, mexa em `src/features/orchestrator/cliBridge.ts`.
5. Os testes de contrato em `ipc/test.rs` leem esses arquivos com `include_str!`: um comando que a CLI oferece e ninguém atende quebra o teste.
6. Atualize `skills/ags-orchestrator/SKILL.md` (e a versão dela).

## MCP
- `ags mcp --cwd <pasta> [--tab id] [--mission id] [--role]` serve as abas interativas; `ags mcp --task <id>` serve as tasks da frota.
- É JSON-RPC 2.0 por stdio, e funciona como ponte: cada `tools/call` vira um `Request` do mesmo protocolo.
- O servidor se chama `ags`; as tools aparecem como `mcp__ags__…`, e a de permissão é `approve_tool_use`. Os configs ficam em `~/.ags/mcp/`.
- As tools `memory_*` só existem para tasks da frota. Abas de TUI usam a CLI.
- Papéis de somente leitura recebem só a power `Read` (`powers_for_role`; `docs/ade-ags/MCP_MISSION_SCOPE.md`).

## Dados em disco
| Onde | O quê |
|---|---|
| `~/.ags/` | `data.db` (+ backups `data.v<N>-*.backup`), `ipc.json`, `ipc/`, `mcp/`, `canvas.json`, `canvas-roles.json`, `canvas-assets/`, `chat.json`, `routines.json`, `floors.json`, `floors/`, `worktrees/`, `runs/` (NDJSON), `memory/` (projeção Markdown), `inbox/`, `skills/`, `screens/`, `cargo-target-agents/` |
| `%APPDATA%\com.luis.controlcode` | contas (perfis isolados), estado do navegador, forge, sync |
| `%LOCALAPPDATA%\ADE AGS\` | app instalado (NSIS por usuário): `ade-ags.exe`, `ags.exe`, `ccode.exe`, `binaries\`, `skills\`, `notifications\` |
| `%LOCALAPPDATA%\ade-ags-dev-data` | instância de debug isolada (`ADE_AGS_DATA_DIR`, `docs/ade-ags/DEV_LOCAL.md`) |

- O identifier `com.luis.controlcode` e o `~/.ags` **não se renomeiam** (`docs/ade-ags/REBRAND.md`). O antigo `~/.controlcode` é migrado por `util/legacy.rs`.
- Com `ADE_AGS_DATA_DIR` definido, o `ags` só fala com aquela instância.
