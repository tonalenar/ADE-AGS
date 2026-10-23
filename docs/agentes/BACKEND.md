# Backend (`src-tauri/`)

> Parte do guia de agentes. Índice e regras de ouro: [`AGENTS.md`](../../AGENTS.md).

Crate `ade-ags` (edition 2024), lib `ade_ags_lib`. O `src/main.rs` chama `ade_ags_lib::run()`, que fica em `app/run.rs`.

## Regras
- **Processos só via `util::spawn`.** O teste `util/spawn_lint.rs` falha se aparecer `Command::new` fora dos lugares permitidos.
- **Caminhos passados a git ou a outros programas externos no Windows passam por `util::external_path`.**
- **Nenhuma migração apaga dados do usuário**: todas são aditivas e idempotentes.
- **Segredos só no keyring.** Nunca no banco, em log ou no ambiente de um agente.
- **Nunca segure o mutex do banco** enquanto roda git, `gh`, HTTP ou um modelo, ou enquanto chama o frontend (`ask_frontend`).
- **Respeite `ADE_AGS_DATA_DIR`** (`util::datadir`); não escreva `~/.ags` fixo no código.
- Meta: **zero warnings** na lib e nos testes.

## Mapa de módulos
| Módulo | Papel |
|---|---|
| `app/` | arranque, `invoke_handler` (`run.rs`), janelas, saída, `--headless`, WebKitGTK |
| `agents/` | `registry.rs` (tabela `AGENTS`), `adapter.rs` (trait `AgentAdapter` e `Capabilities` derivadas), detecção, agentes custom, atualizações, `contract.rs` |
| `accounts/` | várias contas por TUI (isoladas por env: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`), pools, saúde, keyring, OAuth do Antigravity |
| `terminal/` | PTY (portable-pty + ConPTY próprio), contenção de processos (Job Object/grupo POSIX), token `ADE_SESSION`, anexos |
| `ipc/` | servidor da CLI (`protocol.rs`, `server.rs`, `transport.rs`), `commands/dispatch.rs`, `bridge.rs` (pede ao front), `mcp.rs` — ver [CLI_MCP.md](CLI_MCP.md) |
| `missions/` | missões, equipe (`team.rs`), entrega, revisão, conflitos, precheck, timings, `vigia.rs` — ver [ORQUESTRACAO.md](ORQUESTRACAO.md) |
| `runs/` | frota headless: supervisor, scheduler, roteamento, worktrees, broker, sandbox, handoff, fix rounds |
| `squads/`, `roles.rs` | squads e papéis |
| `memory.rs` + `memory/` | memória persistente — ver [MEMORIA.md](MEMORIA.md) |
| `decisions/` | Jev/Laya — ver [JEV.md](JEV.md) |
| `canvas/`, `chat.rs`, `routines.rs`, `floors*.rs`, `design.rs` | canvas (as conexões funcionam como permissões), chat do usuário, rotinas, andares, pranchetas |
| `preview/` | proxy local do navegador (seletor, rede, mocks, capturas) |
| `forge/`, `scm/`, `explorer/` | GitHub/GitLab/Gitea (token no keyring), git local, árvore e busca |
| `session/`, `usage/` | descobrir sessões das TUIs; uso, limites, budget, preços |
| `skills/`, `marketplace/`, `sync/`, `graphify/` | skills (symlink/junction), registries, sync por git |
| `testspeed/` | `ags test affected/run/status` |
| `database/` | SQLite, schema, migrações, seeds, queries |
| `bus.rs`, `notifier*` | barramento de eventos (`bus::publish`), notificações do SO |
| `util/` | helpers obrigatórios (abaixo) |

Binários:
- `ade-ags`: o app.
- **`ags`** (`src/bin/cli.rs`): a CLI. Fica no mesmo crate para compartilhar `ipc::protocol`.
- `ccode`: alias do nome antigo.

## Receitas
### Comando Tauri novo
1. Escreva `#[tauri::command] pub fn nome(...) -> Result<T, String>` no módulo do domínio, normalmente em `commands.rs`.
2. Reexporte no `mod.rs`. Se o reexport não for glob, exporte também `__cmd__nome` e `__tauri_command_name_nome`, como em `database/mod.rs`.
3. Adicione o caminho ao `tauri::generate_handler![…]` em `src-tauri/src/app/run.rs`.
4. Crie o wrapper em `src/features/<domínio>/ipc.ts`.
5. `capabilities/default.json` só lista plugins; comandos do próprio app não entram lá.

### Comando novo da CLI `ags`
Veja [CLI_MCP.md](CLI_MCP.md#comando-novo).

### Agente (TUI) de fábrica novo
1. Acrescente a entrada em `AGENTS` (`agents/registry.rs`).
2. Crie o adaptador na **mesma ordem** em `ADAPTERS` (`agents/adapter.rs`).
3. Escreva o teste em `agents/contract.rs`.

Cuidados:
- Se a CLI aceita um id de sessão escolhido pelo app, declare `assign_session` (Claude: `--session-id {session}`; OpenCode: `--session {session}`). Teste a flag de verdade antes de ligar.
- **Nunca** use `launch_args` em runs de missão ou frota: lá a política é negar permissões.
- Para poder ser lead headless, o adaptador precisa implementar `enforces_read_only()`.

## Banco de dados
- Fica em `~/.ags/data.db`, com WAL, `foreign_keys=ON` e `busy_timeout=5000`. O handle é `DbConnection = Arc<Mutex<Connection>>`.
- Migrações (`database/schema.rs`):
  - `SCHEMA_VERSION` fica em `PRAGMA user_version`;
  - `migrate()` roda inteiro a cada abertura, **só avança e é idempotente** (`if version < N`; `ADD COLUMN` protegido por `has_column()`/`table_exists()`);
  - nada é apagado; o que não migra vira `_legacy_*`;
  - antes de subir a versão, há backup com `VACUUM INTO`.
- Vários acréscimos recentes são aditivos **sem subir** `user_version`, porque os testes fixam versões e subir dispara o backup. Veja os comentários perto do fim de `schema.rs`.
- Alguns módulos têm o próprio `migrate()` (`decisions/log.rs`, `design.rs`, `memory/dream.rs`, `missions/messages.rs`, `testspeed/run.rs`).
- Seeds (`seeds.rs`) nunca sobrescrevem uma decisão do usuário.
- Escritas usam `TransactionBehavior::Immediate`.
- Nos testes, use `crate::database::test_db()` (banco em memória com o schema real). **Testes nunca tocam `~/.ags`.**

## Helpers obrigatórios (`util/`)
- **`util::spawn`**: `command`, `hidden_command`, `output`, `wait_copying_stdout` (com timeout) e `CREATE_NO_WINDOW`. `cmd /C` só é permitido no Graphify e no prelaunch.
- **`util::launch::external_command`**: shims `.cmd`/npm sem passar por shell (CVE-2024-24576).
- **`util::external_path`** (dunce): tira o prefixo `\\?\`, que o git rejeita. Aplique só ao montar o `Command`.
- **`util::path_env::{find_program, program}`**: o PATH real do usuário.
- **`util::now_ts` / `now_ts_ms`**: a única definição de "agora".
- **`util::datadir`**: `ADE_AGS_DATA_DIR`.
- **`bus::publish`**: nunca pega o lock do banco.

## Convenções
- Erros: `Result<T, String>` com `.map_err(|e| e.to_string())`. Não há `thiserror`, e o `anyhow` aparece só no ConPTY. Handlers IPC retornam `Result<serde_json::Value, String>`.
- Testes:
  - num `test.rs` ao lado do módulo (`#[cfg(test)] mod test;`);
  - nomes como frase (`fn las_carpetas_van_antes_que_los_archivos`);
  - teste de rede leva `#[ignore = "necesita red"]`; teste com CLI real leva `#[ignore = "<motivo>"]` (`CC_E2E_<AGENTE>_MODEL`). `#[ignore]` sem motivo reprova no `bun run check:test-lint`;
  - nada de `thread::sleep` para esperar: use canal, evento ou `tokio::time::pause`.
- `mod.rs` só declara e reexporta.
- Mexa no ambiente do processo só antes de existir qualquer thread. Veja os `// SAFETY:` em `app/rendering.rs`, `ipc/server.rs` e `util/path_env.rs`; a ordem de `app::run` importa.
- As versões de `windows`/`windows-sys`/`webview2-com` precisam casar com as que o tauri/wry usa; senão o app quebra com `STATUS_ENTRYPOINT_NOT_FOUND`.
- `main.rs:1` tem `windows_subsystem` marcado "DO NOT REMOVE".
- Fechar uma janela nunca abre outra no lugar (`window/manager.rs`).

## Build e testes
- `cd src-tauri && cargo test --lib --bin ags` é a mesma suíte do CI. Tempos: ~68 s completa; build frio ~205 s; incremental ~15 s.
- O target compartilhado dos agentes é `~/.ags/cargo-target-agents`, configurável por `ADE_AGS_CARGO_TARGET_DIR=shared|per-worktree|<caminho>`.
- O CI do Windows roda só `cargo check --lib --bins --tests`. Os testes com `#[cfg(windows)]` são rodados à mão no Windows.
- Não há clippy no CI; rode `cargo clippy --all-targets` se você mexeu em Rust.
