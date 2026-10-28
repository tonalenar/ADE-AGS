# Canal estruturado em paralelo ao terminal

O ADE roda as TUIs de verdade (Claude Code, Codex, OpenCode…) em PTYs e descobre o estado de cada uma lendo a tela: `esc to interrupt`, diálogos, `?` no fim. É frágil (ver `REPLAY_TESTES.md`). O T3 Code usa protocolos estruturados (app-server do Codex, ACP, Agent SDK do Claude), mas eles **substituem** a TUI.

Aqui o caminho é híbrido: a TUI continua sendo a TUI, e o ADE lê **ao lado** um canal que diz o estado com autoridade. O canal mais barato que convive com a TUI aberta é o **transcript que ela própria grava enquanto roda**.

## O que cada agente deixa ler (verificado nesta máquina em 22/10/2026)

Formatos conferidos lendo só a estrutura (tipos e chaves) de arquivos locais. Nenhum conteúdo de conversa foi copiado: as fixtures dos testes são sintéticas.

| Agente | Versão | Onde | Turno começou | Turno acabou | Ferramenta | Aprovação | Pergunta | Tokens |
|---|---|---|---|---|---|---|---|---|
| Claude Code | 2.1.300–2.1.308 | `~/.claude/projects/<cwd com não-alfanuméricos → ->/<sessão>.jsonl` (ou `CLAUDE_CONFIG_DIR/projects`) | linha `user` com texto (`turnOrigin` `human`/`sdk`/`task_notification`) | `system/turn_duration`; `assistant` com `stop_reason: end_turn`; `[Request interrupted by user…]` | `tool_use` (id) → `tool_result` (`tool_use_id`) | **só depois**: `permissionDecision {decision, source}` na linha do resultado (`user_temporary`/`user_permanent` = a pessoa respondeu); `toolDenialKind: user-rejected` | `AskUserQuestion` (`input.questions[].question/options[].label`) pendente | `message.usage` (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`), repetido em cada linha da mesma resposta (`message.id`) |
| Codex | codex-cli 0.163.0 | `~/.codex/sessions/AAAA/MM/DD/rollout-<data>-<id>.jsonl` (ou `CODEX_HOME`); os antigos viram `.jsonl.zst` | `event_msg/task_started` | `event_msg/task_complete` (`last_agent_message`); `event_msg/turn_aborted` (`reason: interrupted`) | `response_item/custom_tool_call` (`exec`, `input` = o comando) ou `function_call` → `*_output` (`call_id`) | **não grava**: 14 `turn_context` com `approval_policy: on-request` e nenhum evento de aprovação | `request_user_input` não visto | `event_msg/token_count.info.{last,total}_token_usage` (`input_tokens` inclui `cached_input_tokens`) |
| OpenCode | v2.0.31 | `~/.local/share/opencode/opencode.db` (SQLite, WAL) | `message` user | `message.data.time.completed` + `finish: stop`; `session_message` tipo `idle` | `part` tipo `tool`, `state.status` `pending/running/completed/error` | não persistida (a tabela `permission` guarda só regras "sempre") | — | `message.data.tokens` (já lido por `usage/opencode.rs`) |
| Gemini, Kimi, Hermes, Antigravity | não instalados nesta máquina | — | — | — | — | — | — | — |

Observações:

- **Tamanho**: há um rollout de 187 MB nesta máquina. O leitor nunca relê o começo: a primeira leitura pega só os últimos 512 KB e depois só o que cresceu.
- **Subagentes**: linhas `isSidechain: true` (Claude) são ignoradas.
- **Sessão da aba**: o ADE já guarda `tabs.session_id`. O Claude recebe o id no lançamento (`--session-id`, `assign_session`); o Codex é descoberto pelo cabeçalho `session_meta` (`session/title.rs`). O rollout é achado pelo id **no nome do arquivo**, sem abrir nada. Sem id, não há canal: "o mais novo da pasta" pode ser de outra aba.

### Outros canais (só viabilidade, nada implementado)

- **App-server do Codex compartilhando a thread com a TUI**: no 0.163 parece possível. `codex --help` mostra que a TUI usa um *"shared background server"* (`--no-daemon` para não usar), `codex agents` *"Browse all agent sessions on the shared local app-server daemon"* e `codex app-server proxy` liga o stdio ao socket de controle (`~/.codex/app-server-control/app-server-control.sock`). Um segundo cliente JSON-RPC poderia ler a thread e, talvez, os pedidos de aprovação. **Não testado**: é experimental, e um cliente que responde aprovações é exatamente o que exige OK do usuário. Seria o caminho para aprovações firmes no Codex.
- **Hooks do Claude Code**: `Notification` (`permission_prompt`) e `PermissionRequest` dariam o pedido de aprovação **na hora**. O ADE controla o comando de lançamento e poderia passar `--settings` só para as abas dele, sem mexer nos arquivos do usuário. Muda o lançamento: fica para depois, com OK.
- **ACP (Antigravity, Grok)**: o ACP substitui a TUI (o cliente é quem desenha). Não convive com a TUI aberta; não foi testado aqui.
- **SQLite do OpenCode**: daria turno e ferramenta (leitura só leitura, como `usage/opencode.rs`), mas não aprovações. Não implementado nesta rodada.

## Como funciona

```text
transcript da TUI ──(Tailer: só o que cresceu)──► parser do agente ──► eventos normalizados
                                                                         │
                                         TabState (máquina de estados) ◄─┘
                                                │
             ┌──────────────────────────────────┼─────────────────────────────┐
             ▼                                  ▼                             ▼
   canal::busy(tab) (Rust)            cc-structured-state (janela)      pendências (SQLite)
   fila de mensagens, peer ask        Vigia, agente/orquestrador parado  aviso ao orquestrador
```

### Eventos normalizados (`canal/event.rs`)

`TurnStarted`, `TurnEnded{completed|interrupted, última fala}`, `ToolStarted{id, nome, resumo}`, `ToolFinished{id, decisão}`, `Question{id, texto, opções}`, `ApprovalRequested` (só se um agente passar a gravar), `AssistantText`, `Usage{last, total}`. Tokens normalizados: `input` é sempre a entrada **não** cacheada.

### Estado por aba (`canal/state.rs`)

- `phase`: `working` (turno aberto, inclusive ferramenta pendente ou diálogo), `idle` (turno encerrado) ou `unknown`.
- Ferramenta sem prompt visto abre um turno **deduzido** (`inferred: true`): turno que começou antes do trecho lido, ou continuação depois de um hook de Stop.
- **Estado velho**: turno aberto com o arquivo parado há mais de 10 min (`STALE_OPEN_MS`) vira `unknown` (`stale: true`). Uma ferramenta longa não escreve nada enquanto roda, por isso o prazo é generoso.
- `endsWithQuestion`: a última linha da fala (fora de bloco de código) termina em `?`.

### O laço (`ipc/commands/canal.rs`)

- Uma thread, tique de 1 s; a cada 5 s relê as abas abertas (`tabs` + `windows.is_open`), a conta de cada uma e o modo.
- Cada leitura abre e fecha o arquivo (nenhum handle preso: o Codex compacta os antigos).
- Sessão trocada (`/clear`, resume) zera o estado da aba. Arquivo sumido: sem canal, decide a tela.
- Nunca segura o mutex do banco lendo arquivo ou digitando.

### Modos (`canal.modo` em `settings`, ou `ADE_AGS_CANAL`; o ambiente vence)

| Modo | O que muda |
|---|---|
| `off` | Só se lê e mostra (`ags tab state`). Nenhuma decisão, nenhuma pendência. |
| `veto` (padrão) | Só no sentido seguro. Turno aberto no transcript: a fila e o `peer ask` não digitam mesmo com a tela quieta; o Vigia não cutuca; "agente parado" não dispara; a camada 2 não consulta; uma pergunta velha na tela não vira pedido ao lead. **Nunca faz o ADE escrever mais cedo do que antes.** Pendências registradas e avisadas. |
| `full` | O transcript vence nos dois sentidos no front (turno encerrado vence um spinner velho). No backend é igual ao `veto`. Experimental. |

Sem canal (outro agente, sessão sem arquivo, estado velho, modo `off`), o comportamento é **idêntico** ao de antes: `busy()` é falso e `workingWith(tab, tela)` devolve a tela.

## Pendências: aprovações e perguntas (`canal/pending.rs`)

| Tipo | De onde vem | Firmeza |
|---|---|---|
| `question` | `AskUserQuestion` pendente no transcript (Claude) | firme |
| `approval` | ferramenta pendente há ≥ 2 s no transcript **e** diálogo de permissão no fim da tela (`dialog_on_screen`) | híbrido: a tela confirma o diálogo, o transcript diz qual ferramenta e qual comando |
| `turn_question` | turno encerrado com a fala terminando em pergunta | heurística: só listada, **não** vira aviso (o detector de "orquestrador parado" já avisa) |

- Tabela `agent_pending` (migração aditiva, sem subir `user_version`): uma linha por (aba, chave), `pending → answered | expired`. Nunca reaberta.
- Some do estado (a pessoa respondeu, a ferramenta terminou, um turno novo começou) → `answered` por `tui`. Aba fechada ou 2 h sem resposta → `expired`. Resolvidas saem depois de 3 dias.
- Texto que parece segredo (`looks_like_secret`) é trocado por "(oculto…)".
- **Aviso ao orquestrador**: depois de 15 s (aprovação) ou 10 s (pergunta) sem resposta, uma mensagem `notice` entra na fila do orquestrador da aba (a vizinha com a coroa): `[ADE AGS · pendência #N] "Dev" espera aprovação para Bash: git push … ags peer answer N 1 …`. Uma vez só. Sem orquestrador, fica só na lista.

### CLI

```text
ags tab state <id>                  o estado completo (fase, ferramentas, pergunta, tokens, modo)
ags tab list                        cada aba com canal ganha "structured": {phase, tools, question, endsWithQuestion}
ags peer pending [--all]            as pendências das abas que você alcança
ags peer answer <id> <resposta> [--enter]
```

`peer answer`:
- só o **orquestrador** (coroa) que alcança o integrante;
- num diálogo (`approval`, `question`) só aceita teclas de diálogo: dígito, `y`, `n`, `a`, `p`, `esc`, `enter` (texto livre poderia escolher outra opção);
- antes de digitar, com o `delivery_lock` do integrante, confere de novo que a pendência segue aberta no transcript e, na aprovação, que o diálogo segue na tela; senão não digita nada;
- `turn_question`: a resposta vai como um `peer tell` normal (fila, cabeçalho, recibo).

## Arquivos

| Arquivo | Papel |
|---|---|
| `src-tauri/src/canal/event.rs` | eventos, tokens, `parse_ts_ms`, `ends_with_question` |
| `src-tauri/src/canal/claude.rs`, `codex.rs` | uma linha → eventos |
| `src-tauri/src/canal/state.rs` | máquina de estados, prazo de estado velho |
| `src-tauri/src/canal/tail.rs` | leitor incremental (janela do fim, linhas parciais, arquivo que encolhe, linha gigante) |
| `src-tauri/src/canal/mod.rs` | modo, caminho do transcript, `Tracker`, `Snapshot`, `busy()` |
| `src-tauri/src/canal/pending.rs` | sinais de pendência, diálogo na tela, tabela `agent_pending` |
| `src-tauri/src/ipc/commands/canal.rs` | o laço, o aviso, `tab.state`, `peer.pending`, `peer.answer`, `structured_state_all` |
| `src-tauri/src/ipc/commands/peer_queue.rs`, `peers.rs` | o veto na entrega e no `peer ask` |
| `src/features/terminal/structuredState.ts` | o estado na janela e `workingWith` |
| `src/features/missions/{vigia,stalled,leadStall,watcher}.ts` | o uso no Vigia e nos detectores |

## Testes

- Rust: `cargo test --lib canal` (parsers com linhas sintéticas, máquina de estados, leitor, busca do rollout, sinais, diálogo, migração idempotente, `sync`, aviso, expiração, segredo; o texto do aviso e as teclas aceitas).
- Front: `bunx vitest run src/features/terminal/tests/structuredState.test.ts` (veredito, combinação por modo, detectores com e sem canal).
- Conferido à mão (sem commitar nada): os parsers leram transcripts reais desta máquina e cortes deles no meio de um turno (Claude: turno deduzido com 2 `Bash` pendentes; Codex: turno aberto com `exec` pendente; os completos, `idle`).

## Limites e riscos

- **Aprovação não é firme em nenhum agente.** O Claude só grava a decisão depois; o Codex não grava. A pendência `approval` depende do diálogo na tela (o mesmo problema de antes, mas só para *confirmar*: a ferramenta e o comando vêm do transcript).
- **Turno aberto preso**: se a TUI morre no meio do turno, o veto segura mensagens por até 10 min (depois vira `unknown`). A fila tem o próprio prazo de 15 min.
- **`/clear` no Claude** troca o id da sessão; até a aba descobrir o id novo, o estado é o do arquivo antigo (`idle`). Em `veto` isso não muda nada; em `full` pode desligar o "trabalhando" da tela: por isso o `full` é experimental.
- O uso de tokens do Claude é somado só a partir do trecho lido (`totalScope: observed`); o do Codex é o da sessão (`session`).
- `request_user_input` (Codex) e os pedidos de aprovação gravados são lidos se aparecerem, mas não foram vistos nesta máquina.
- As teclas de resposta (`1` no Claude, `y` no Codex) foram tiradas do desenho conhecido dos diálogos, **não testadas ao vivo**.
- Um orquestrador aprovando a ferramenta de outro agente é poder real: o aviso diz que é dado do integrante, não ordem do usuário, e manda deixar com o usuário na dúvida.
