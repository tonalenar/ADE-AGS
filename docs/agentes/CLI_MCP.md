# CLI `ags`, MCP e dados em disco

> Parte do guia de agentes. Índice e regras de ouro: [`AGENTS.md`](../../AGENTS.md).

## Regras para quem usa a CLI
- Para pilotar o app, siga a skill **[`skills/ags-orchestrator/SKILL.md`](../../skills/ags-orchestrator/SKILL.md)**.
- Olhe antes de criar: `ags workspace status`, `ags peers`, `ags agents`, `ags accounts`.
- Informe ao usuário os ids das abas que você abriu.
- **Nunca faça polling.** Use `ags watch add/wait` ou `ags events wait`.
- Observe no máximo 3 abas. Comandos longos vão numa aba de terminal (`--agent bash`).
- Comando interativo (login, código, pergunta, assistente) nunca roda no shell escondido do agente. De uma conversa do chat, `ags tab create --agent bash --initprompt "…"` (ou `--in-chat`) usa o terminal do painel direito, o mesmo em que a pessoa digita; sem ele, o comando vai num bloco ```bash para o **Rodar** do chat.
- Aba que você não abriu é do usuário.
- Exit codes:
  - 0: ok;
  - 1: o comando falhou (leia `.error`);
  - 2: erro de uso;
  - 3: o app não está rodando (pare e peça ao usuário para abri-lo).

## Protocolo
- Uma linha JSON `{token, command: "grupo.ação", args}` → `{ok, data, error}` (`ipc/protocol.rs`, `PROTOCOL_VERSION = 1`).
- Transporte (`ipc/transport.rs`): a CLI usa o canal que entrega o PID de quem chama, quando o handshake o anuncia (campo `socket`):
  - macOS e Linux: socket Unix `~/.ags/ipc/<pid>.sock` (macOS lê o PID com `LOCAL_PEERPID`; Linux com `SO_PEERCRED`);
  - Windows: um named pipe por PID (`\\.\pipe\ags-ipc-<pid>`), com `GetNamedPipeClientProcessId`;
  - TCP em `127.0.0.1`, numa porta aleatória, segue de pé para provar que o app está vivo e para CLIs antigas; não tem PID, então memória, swarm e computer use fecham por ele.
  - O handshake fica em `~/.ags/ipc.json` (global) e em `~/.ags/ipc/<pid>.json`. Os filhos herdam `AGS_HANDSHAKE`.
- **Sandbox do agente**: um sandbox que bloqueia AF_UNIX (o `workspace-write` do Codex, o seatbelt fechado do Gemini, o sandbox do Bash do Claude Code) faz todo `ags` falhar com `Operation not permitted`. A CLI devolve exit 1 com o que fazer em cada agente e **nunca** manda reiniciar o app (`credential_connect_error`). Opções e medições em [`COMPUTER_USE_SUPERFICIES.md`](../ade-ags/COMPUTER_USE_SUPERFICIES.md#sandbox-dos-agentes).
- **iPhone físico compartilhado com a ADE**: use `ags device list`/`shot`/ações ou MCP `device_list`/`device_shot`/`device_action`. `sim-use ios-device tap` pode aceitar e ignorar toques em apps comuns; não o trate como canal de controle. A confirmação e a confiança do aparelho são aplicadas pela ADE e não devem ser contornadas.
- Limites: 256 conexões e 8 MB por request. O token é comparado em tempo constante.
- `memory.*` e `swarm.*` exigem `ADE_SESSION` e que o processo seja descendente do PTY da aba (`terminal/session.rs::authorize`).
- `approval.decide` e `approval.list` são recusados a **todo** chamador do IPC (`person_only_error`, antes de token de tarefa, PID e banco): o servidor não prova que quem chama não é agente. Decidir aprovação da Frota é só pela tela (`run_decide_approval`). Nenhum comando novo pode decidir, listar ou lembrar regra de aprovação pelo IPC; o teste `nenhum_caminho_do_ipc_decide_lista_nem_lembra_regra_de_aprovacao` cobra.
- `memory.compact` e `workspace.restore` são negados a agentes (`AGENT_MAINTENANCE_DENIED`): só pela UI.
- Conversa por protocolo (`thread:<id>`) também recebe `ADE_SESSION`, emitido por processo do motor e válido após `register_process` (`chat_team/env.rs`).
- `ADE_TAB_ID` identifica quem chama, mas **não é segurança**.
- `ags run.*` propaga `ADE_TAB_ID` no campo `tabId`, sobrescrevendo qualquer `tabId`/`from` passado pelo agente. Em uma conversa estruturada (`ADE_TAB_ID=thread:<id>`), `run_plan`, `task_add`, `delegate_task`, `status`, `result` e `await` ficam no escopo do run daquela conversa; sem identidade de thread, continua valendo a resolução por pasta.
- A saída é sempre uma linha JSON no stdout; ajuda e erros de uso vão para o stderr.

## Grupos de comando
`tab`, `peer(s)`, `portal(s)`/`open`, `say`/`recall`, `routine(s)`, `floor(s)`, `role(s)`, `note(s)`, `design`, `watch`, `events`, `mission`, `worktrees`, `approval`, `memory`, `swarm`, `window`, `workspace`, `run`, `browser run`, `agents`, `accounts`, `pool(s)`, `prelaunch`, `skills`/`skill`, `device(s)` (Android e iPhone/iPad físico vinculado), `ci watch`, `test` (roda local, sem o app), `app status`, `mcp`.

Flags globais: `--version` e `--json-args '{…}'`. Uma URL `http…` solta vira `portal.open`, porque o app define `BROWSER=ags`.

## Comando novo
1. Escreva o handler em `ipc/commands/<x>.rs`, retornando `Result<serde_json::Value, String>`. Leia os argumentos com `arg_str`, `arg_str_opt`, `arg_u64_checked`.
2. Acrescente o braço no `match` de `ipc/commands/dispatch.rs`.
3. Em `bin/cli.rs`, escreva o USAGE (em PT-BR) e os `positionals()`. Se o comando precisar da identidade da aba, inclua o grupo em `with_caller()`; atalhos de uma palavra ficam em `shortcut()`.
4. Se o comando vier por MCP, mexa em `ipc/mcp.rs` (e em `runs/orchestration.rs`). Se só o front sabe executá-lo, mexa em `src/features/orchestrator/cliBridge.ts`.
5. Os testes de contrato em `ipc/test.rs` leem esses arquivos com `include_str!`: um comando que a CLI oferece e ninguém atende quebra o teste.
6. Atualize `skills/ags-orchestrator/SKILL.md` (e a versão dela) e rode `bun run gen:catalogs`: o índice de comandos e a lista de tools da skill, da ajuda e deste doc são regiões geradas (`BEGIN/END GENERATED`), conferidas por `bun run check:catalogs`.

## Skills embutidas
- `ags-orchestrator` é nossa: mude o `SKILL.md` e suba a versão.
- `jev-sim-use` e `agent-desktop` são de terceiros, fixadas em `skills/vendor.lock.json`. **Não as edite à mão**, fora o bloco `ADE AGS:BEGIN/END`. Para atualizar, use `bun scripts/vendor-skills.ts --update <nome> --tag <tag> --commit <sha>`; o teste de hash quebra com qualquer outra mudança. Detalhe em [`SKILLS_TERCEIROS.md`](../ade-ags/SKILLS_TERCEIROS.md).

## MCP
- `ags mcp --cwd <pasta> [--tab id] [--mission id] [--role]` serve as abas interativas; `ags mcp --task <id>` serve as tasks da frota.
- Conversas por protocolo Codex, Claude Code e OpenCode recebem esse MCP escopado ao `thread:<id>` no próprio processo; o Codex usa overrides `-c`, o Claude usa config da conversa e o OpenCode usa `OPENCODE_CONFIG_CONTENT` mesclado com a política de acesso. Antigravity recebe o MCP numa `.agents/mcp_config.json` isolada, passada em `--add-dir`, mais `--settings` temporário com as tools pré-aprovadas pela ADE. A TUI do Codex recebe configuração MCP por processo. A CLI atual do Kimi Code não oferece MCP por processo: ele só lê configurações global e de projeto. A ADE preserva ambas; com a skill `ags-orchestrator` montada, Kimi ainda pode chamar a CLI `ags` pela ferramenta Shell. Nenhum caminho suportado altera a configuração global. `agent_roster`/`run.roster` listam executores headless da Frota; `chat_providers`/`chat.providers` listam conversas estruturadas nativas e os ACP locais configurados, com capacidades do protocolo. `delegate_agent` unifica a delegação em três destinos explícitos (`target`): `provider_chat` (conversa de provider nativo), `fleet_task` (tarefa headless) e `connected_session` (sessão já aberta e ligada ao time, descoberta por `team_candidates`); `execution=chat|fleet` continua como apelido dos dois primeiros. Exige `client_request_id` estável nos três (a repetição devolve a mesma conversa, run ou mensagem; outro conteúdo falha fechado), aceita `mode=async|wait` e devolve o resultado diretamente no modo de espera. Em `connected_session` a ADE revalida no envio, antes de escrever, que a sessão existe e está conectada, não está ocupada (salvo `when_busy=queue`), está na mesma pasta ou já ligada pela pessoa e tem política dentro do teto `ask`; a falha volta como `<código>: <mensagem>` e nada é enviado. Na CLI: `ags team delegate <nome> --task "..." --client-request-id <id>`. Contrato em [`HARNESS_CONTRATO.md` §12](../ade-ags/HARNESS_CONTRATO.md#12-fase-4-delegação-única-delegate_agent-com-três-destinos). A criança recebe apenas a tarefa e `context` explicitamente escolhido (limite UTF-8 de 16 KiB, marcado como dado não confiável), nunca o histórico do pai. `harness_graph` lê o snapshot de lineage da conversa estruturada chamadora, sem aceitar outro ID de thread; inclui conversas descendentes, turns, tarefas/execuções Fleet e eventos semânticos recentes. Para fluxos específicos, `delegate_task` continua disponível para tarefa headless e `chat_new` para conversa nativa; `run_plan` declara um DAG da Frota com qualquer agente/modelo disponível no roster. `client_request_id` torna as criações idempotentes e rejeita conteúdo diferente para a mesma chave. A ADE persiste a fase do primeiro envio nativo para não repetir uma mensagem cujo resultado pode ser incerto; nesse caso, confira a thread filha antes de enviar outra mensagem. `task_cancel` cancela a tarefa escolhida e todos os descendentes ativos da Frota na mesma transação; um worker em fase de spawn também encerra se a tarefa já tiver sido cancelada. A thread nativa fica ligada no painel lateral, herda o provider se `agent` for omitido, inicia em Supervisionado e pode ser acompanhada com `chat_wait`/`chat_show` ou interrompida com `chat_stop`. O grafo comum ainda não dá recuperação completa de sessões nativas após reinício. No `agy --print`, uma ação que pede aprovação não tem como abrir diálogo; ela só passa com Acesso total.
- Chats estruturados guardam o id do workspace de origem separadamente do `cwd`; assim o `run_plan` continua encontrando o workspace quando o agente está num worktree. Conversas antigas sem esse campo ainda tentam inferir pelo caminho.
- `ags chat providers` lista os runtimes nativos de conversa, separados do roster headless da Frota. `ags chat compact <thread>` compacta Codex ou Claude Code quando não há turno/pedido pendente. `ags chat goal <thread> --action show|set|pause|resume|clear` controla os objetivos persistentes disponíveis em Codex e Claude Code; pause/resume é exclusivo do Codex. O MCP expõe `chat_providers`, `chat_compact` e `chat_goal` com os mesmos limites de capacidade.
- É JSON-RPC 2.0 por stdio, e funciona como ponte: cada `tools/call` vira um `Request` do mesmo protocolo.
- O servidor padrão se chama `ags`; as tools aparecem como `mcp__ags__…`, e a de permissão é `approve_tool_use`. Os configs em arquivo ficam em `~/.ags/mcp/`; o override do Codex TUI existe somente no argv do processo.
- As tools `memory_*` só existem para tasks da frota. Abas de TUI usam a CLI.
- Papéis de somente leitura recebem só a power `Read` (`powers_for_role`; `docs/ade-ags/MCP_MISSION_SCOPE.md`).
- Resposta grande (acima de ~6.000 tokens) de uma tool, ou de `tab output`/`tab screen`/`peer check`/`peer pending`/`chat show`/`chat wait`/`recall get` na CLI, vai inteira para `~/.ags/spill/<aba ou tarefa>/<aleatório>.txt` (pasta 0700, arquivo 0600, nunca dentro de um repositório, apagado após 30 dias); o agente recebe cabeça, cauda e o caminho (`ipc/spill.rs`). Na CLI, `--no-spill` devolve tudo.
- `browser_act`, `sim_act` e `desk_act` são o `portal act`/`sim act`/`desk act` da CLI, com o mesmo prazo (`timeout`, padrão 115 s, faixa 10–1.800, `ipc::mcp::act_timeout_secs`). `sim_act`/`desk_act` repassam a identidade herdada pelo processo do MCP (`ADE_TAB_ID`, `ADE_SESSION` ou o `--tab`) e o backend confere com `authorize_actor`; o `from`/`session` mandado pelo modelo é descartado. Não existem para tarefas da frota. `sim_act` se aprova sozinha (como o navegador); `desk_act` pede aprovação na TUI.
- `sim_act` faz OCR local, consulta o Jev em texto e usa os centros das caixas OCR; a foto só sai da máquina quando a decisão pede o fallback visual para ícones sem rótulo ou texto ambíguo. Cliques escolhidos só pelo texto pedem confirmação até a confiança persistente do aparelho; controles sensíveis e digitação sempre pedem.
- Para navegar por várias telas do iPhone, passe o objetivo inteiro em uma chamada `sim_act` com passos suficientes. Não envie uma atualização ao usuário a cada tela; informe o resultado verificado ao final, a menos que ele peça progresso ou que uma confirmação/bloqueio exija resposta.
- `ask_user` tem prazo (padrão 600 s): ao vencer devolve `status: "pending"`, nunca aprovação, e a resposta tardia chega à aba como mensagem. Integrante de time recebe `refused` (`ask_lead`) e leva a dúvida ao orquestrador.
- Segredos temporários: `secret_request`/`secret_run`/`secret_revoke` só aparecem para conversas interativas, nunca para tasks headless. O valor fica no keyring por até 24 h, vinculado à conversa; `secret_run` o envia apenas no stdin de um executável e descarta stdout/stderr. O uso pede a aprovação normal da TUI. Para um cliente sem MCP por sessão, a skill oferece `ags secret request`, `ags secret run <id> -- <programa>` e `ags secret revoke <id>`; `secret.consume` é recusado pela CLI comum.

### Tools (região gerada)
A tabela abaixo sai de `ipc/mcp.rs` e `forge/tools.rs`; o mesmo vale para a ajuda de `ags` e para a skill. Mudou uma tool ou um comando? Rode `bun run gen:catalogs`; o CI roda `bun run check:catalogs`.

<!-- BEGIN GENERATED: mcp-tools -->
<!-- Gerado por `bun run gen:catalogs` a partir do código; não edite à mão. -->
| Family | Who sees it | Tools |
|---|---|---|
| Browser | every session | `browser_navigate`, `browser_pick`, `browser_marked`, `browser_snapshot`, `browser_click`, `browser_act`, `browser_type`, `browser_press`, `browser_select`, `browser_describe`, `browser_screenshot`, `browser_drag`, `browser_upload`, `browser_mock`, `browser_dialogs`, `browser_hover`, `browser_scroll`, `browser_wait`, `browser_history`, `browser_resize`, `browser_layout`, `browser_console`, `browser_network`, `browser_storage`, `browser_cookies`, `browser_performance`, `browser_eval` |
| Fleet orchestration | every session (read-only roles get only the Read power) | `gemini_desktop_status`, `gemini_desktop_consult`, `gemini_desktop_result`, `agent_roster`, `run_plan`, `task_add`, `delegate_task`, `task_handoff`, `task_status`, `task_result`, `run_await`, `fact_add`, `facts_read`, `fact_read`, `task_reroute`, `task_cancel` |
| Fleet memory | fleet tasks only (`--task`) | `memory_list`, `memory_get`, `memory_search`, `memory_open`, `memory_propose`, `memory_update`, `memory_delete`, `memory_promote_fact` |
| Git account | every session | `git_account`, `git_repos`, `git_pr_list`, `git_pr_view`, `git_checks`, `git_pr_files`, `git_issue_list`, `git_issue_view`, `git_fetch`, `git_pull`, `git_push`, `git_pr_create`, `git_issue_create`, `git_tag`, `git_release_list`, `git_release_create`, `git_comment` |
| Peers and team | interactive tabs (`--tab`) | `peer_ask`, `peer_tell`, `peer_deliver`, `peer_handoff`, `peer_receipt`, `team_list`, `team_candidates`, `team_create`, `team_link`, `team_unlink`, `team_role` |
| Chat-mode conversations | interactive sessions (`--cwd`) | `chat_list`, `chat_providers`, `harness_graph`, `chat_compact`, `chat_goal`, `chat_new`, `delegate_agent`, `chat_send`, `chat_wait`, `chat_show`, `chat_stop`, `chat_pending` |
| Designs | interactive sessions (`--cwd`) | `design_list`, `design_get`, `design_view`, `design_create`, `design_open`, `design_page_add`, `design_page_rename`, `design_page_delete`, `design_artboard_add`, `design_artboard_update`, `design_artboard_duplicate`, `design_artboard_delete`, `design_comment_add`, `design_comment_resolve`, `design_note_add` |
| Computer use | interactive sessions (`--cwd`); the app checks the caller's tab or conversation | `sim_act`, `desk_act` |
| Devices | interactive sessions (`--cwd`); caller reach is checked and fleet tasks are refused | `device_list`, `device_shot`, `device_action` |
| Questions to the person | every session (team members get `refused`, see above) | `ask_user` |
| Temporary secrets | interactive tabs (`--tab`), never headless fleet tasks | `secret_request`, `secret_run`, `secret_revoke` |
| Permission | fleet tasks only (`--task`) | `approve_tool_use` |
<!-- END GENERATED: mcp-tools -->

## Dados em disco
| Onde | O quê |
|---|---|
| `~/.ags/` | `data.db` (+ backups `data.v<N>-*.backup`), `ipc.json`, `ipc/`, `mcp/`, `canvas.json`, `canvas-roles.json`, `canvas-assets/`, `chat.json`, `routines.json`, `floors.json`, `floors/`, `worktrees/`, `runs/` (NDJSON), `memory/` (projeção Markdown), `inbox/`, `skills/`, `screens/`, `cargo-target-agents/` |
| `%APPDATA%\com.luis.controlcode` | contas (perfis isolados), estado do navegador, forge, sync |
| `%LOCALAPPDATA%\ADE AGS\` | app instalado (NSIS por usuário): `ade-ags.exe`, `ags.exe`, `ccode.exe`, `binaries\`, `skills\`, `notifications\` |
| `%LOCALAPPDATA%\ade-ags-dev-data` | instância de debug isolada (`ADE_AGS_DATA_DIR`, `docs/ade-ags/DEV_LOCAL.md`) |

- O identifier `com.luis.controlcode` e o `~/.ags` **não se renomeiam** (`docs/ade-ags/REBRAND.md`). O antigo `~/.controlcode` é migrado por `util/legacy.rs`.
- Com `ADE_AGS_DATA_DIR` definido, o `ags` só fala com aquela instância.
