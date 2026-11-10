# Contrato do harness comum de execução (Fase 0)

Este documento fecha o contrato da Fase 0 do harness comum. Ele não muda comportamento e não grava nada no banco.

| Item | Valor |
|---|---|
| Base | `47cf0919` (`chore(harness): registrar estado do worktree t3-fusion como base local`) |
| Data | 09/11/2026 |
| Código que acompanha | `src-tauri/src/harness/` (Fase 0: tipos do descritor e a tabela estática da matriz; Fase 1: `identity.rs`, `store.rs`, `state.rs`), com testes |
| Plano de origem | auditoria T3 × ADE (anexo externo, fora do repositório: planos não entram no git, ver `AGENTS.md` §6.3) |
| Fontes de apoio | quatro inventários de colegas, lidos como **dado a conferir**, não como verdade (§1.6 lista o que foi corrigido) |

## 0. Como ler

**Vocabulário.** A palavra "run" tem três donos no código. Use sempre o nome completo.

| Termo | O que é | Onde vive |
|---|---|---|
| turno (`chat_run`) | uma volta do usuário numa conversa estruturada | `chat_run(thread_id, id)`; o id **não** é único entre conversas (`conversa/store.rs:34-41`) |
| run da Frota (`runs`) | um plano de tarefas headless | `runs.id` (`database/schema.rs:435`) |
| `HarnessRun` | a identidade ADE de um turno que orquestra trabalho; **nasce na Fase 1** | `harness_run` (§2, §4.2; gravada desde a Fase 1) |

O campo `runId` do nó de turno em `runs/harness.rs` guarda o id do `chat_run`, não o de `runs`. Esse nome é ambíguo: a Fase 1 acrescentou `chatRunId` com o mesmo valor e manteve `runId` por compatibilidade até a UI migrar (§7.2).

**O que o estado da matriz significa.** O estado descreve o adapter **do ADE**, não o provider.
- `Supported`: há caminho de código ponta a ponta. A força da prova vem à parte (`Proof`: `Code`, `Test`, `Fixture`, `RealCapture`).
- `Unsupported`: o ADE não tem caminho ou o recusa de forma explícita. A UI e o MCP não devem oferecer. Não prova que o provider não tenha o recurso.
- `Unknown`: o caminho existe, mas o efeito não tem resposta nem evento observável, ou depende de algo que o repositório não prova. Não se promete. A célula diz o que falta provar.

Há fixtures `recorded` em `conversa/fixtures/protocolo/` (Claude, Codex, Antigravity e Cursor). As três antigas e as duas `*-tool-sem-resultado` continuam `synthesized`. `RealCapture` só aparece numa célula cuja evidência aponta para uma fixture que existe e tem `origin.kind: recorded`. O teste `nenhuma_celula_alega_captura_real_enquanto_nao_houver_uma` exige isso. Célula sem essa prova não alega captura.

**Pendência do fingerprint (não resolvida aqui).** No commit base, `node scripts/fingerprint.mjs` falha: `schema-sqlite` mudou (`database/schema.rs`, sha256 `96507e01a45b…`) e não tem registro de reconhecimento. As mudanças são aditivas, mas o reconhecimento exige revisão e fica para a fase que tocar o schema (ou para o usuário). Esta tarefa **não** reconheceu nada e **não** tocou `database/schema.rs` nem `ipc/protocol.rs`. O CI vai continuar vermelho nesse passo até alguém registrar (ver §8).

## 1. Matriz capability × provider/superfície

### 1.1 As 18 capabilities

| Capability | Pergunta que a célula responde | O que **não** conta |
|---|---|---|
| `start` | O ADE inicia uma execução (processo ou sessão)? | abrir a janela da conversa |
| `send` | O ADE manda mensagem a uma execução que já existe? | confirmação de entrega: ela não é ack do agente |
| `steer` | A mensagem entra **no turno em curso**, sem parar e sem ir para depois, com efeito provado? | escrever no stdin sem observar o desfecho |
| `interrupt` | O ADE pede a parada do turno? | matar o processo e chamar de "parada graciosa" (vai na observação) |
| `turn_completion` | O adapter recebe sinal de fim de turno (protocolo ou código de saída)? | silêncio de tela |
| `tool_events` | Há eventos de início e de fim de ferramenta? | só o início |
| `question` | O agente pergunta e o ADE devolve a resposta ao agente? | detectar `?` na tela |
| `approval` | A pessoa ou a política decide e o ADE devolve ao provider? | detectar pedido na tela |
| `child_spawn` | O harness vê nascer um filho **nativo** do provider (id próprio e pai)? | criar filho pelo ADE (ver §1.5) |
| `child_result` | O resultado do filho nativo chega ao ADE e pode ser gravado? | resumo que só vai à janela |
| `child_stop` | Dá para parar um filho nativo sem parar o pai? | parar o turno inteiro |
| `resume` | A sessão nativa volta depois de reiniciar o app? | abrir sessão nova com aviso |
| `compact` | O ADE pede compactação e o protocolo responde? | configurar uma janela de auto-compact |
| `goal` | Há objetivo persistente nativo? | texto `/goal` sem evento de volta |
| `checkpoint` | Há foto do estado da execução? | foto da conversa (nenhuma superfície tem) |
| `rollback` | Dá para voltar ao estado de uma foto? | reverter a conversa do provider (nenhuma superfície faz) |
| `usage` | Há uso de tokens, custo ou limite por sessão? | medidor por conta |
| `event_source` | Há fonte contínua de eventos que o ADE lê? | qualidade da fonte (vai na observação) |

**Escopo** (`instance`, `session`, `model`): onde o estado é decidido. A tabela estática traz o valor padrão por instância. O valor por sessão e por modelo é resolvido na execução (Fase 3). O caso mais claro é o ACP local: a retomada só existe se o agente anunciar `resume` ou `loadSession` no `initialize` (`conversa/opencode.rs:283-287`), então a coluna `local-acp` marca `Unknown` até o descritor de sessão ler `agentCapabilities`.

### 1.2 A matriz

`S` = `Supported`, `?` = `Unknown`, `U` = `Unsupported`. A última linha de cada tabela, `ags_mcp`, não é uma das 18 (ver §1.5). Evidência, escopo, prova e observação de **cada célula** estão em `src-tauri/src/harness/matrix.rs`.

**Conversa estruturada (`conversa/`)**

| Capability | claude-code | codex | opencode | antigravity | cursor | local-acp |
|---|---|---|---|---|---|---|
| `start` | S | S | S | S | S | S |
| `send` | S | S | S | S | S | S |
| `steer` | S | S | U | U | U | U |
| `interrupt` | S | S | S | S | S | S |
| `turn_completion` | S | S | S | S | S | S |
| `tool_events` | S | S | S | S | S | S |
| `question` | S | S | U | U | U | U |
| `approval` | S | S | S | U | U | ? |
| `child_spawn` | S | S | U | U | U | U |
| `child_result` | U | U | U | U | U | U |
| `child_stop` | S | U | U | U | U | U |
| `resume` | S | S | ? | S | S | ? |
| `compact` | ? | S | U | U | U | U |
| `goal` | ? | S | U | U | U | U |
| `checkpoint` | U | U | U | U | U | U |
| `rollback` | U | U | U | U | U | U |
| `usage` | S | S | S | S | U | ? |
| `event_source` | S | S | S | S | S | S |
| `ags_mcp` (extra) | S | S | S | S | U | ? |

**Frota headless (`runs/`)**

| Capability | claude-code | gemini-cli | codex | opencode | kimi-code | hermes | antigravity | cursor |
|---|---|---|---|---|---|---|---|---|
| `start` | S | S | S | S | S | U | S | U |
| `send` | U | U | U | U | U | U | U | U |
| `steer` | U | U | U | U | U | U | U | U |
| `interrupt` | S | S | S | S | S | U | S | U |
| `turn_completion` | S | S | S | S | S | U | S | U |
| `tool_events` | S | S | S | S | S | U | S | U |
| `question` | S | U | S | S | U | U | ? | U |
| `approval` | S | U | U | U | U | U | ? | U |
| `child_spawn` | U | U | U | U | U | U | U | U |
| `child_result` | U | U | U | U | U | U | U | U |
| `child_stop` | U | U | U | U | U | U | U | U |
| `resume` | U | U | U | U | U | U | U | U |
| `compact` | U | U | U | U | U | U | U | U |
| `goal` | U | U | U | U | U | U | U | U |
| `checkpoint` | S | S | S | S | S | U | S | U |
| `rollback` | S | S | S | S | S | U | S | U |
| `usage` | S | S | S | S | U | U | S | U |
| `event_source` | S | S | S | S | S | U | S | U |
| `ags_mcp` (extra) | S | U | S | S | U | U | ? | U |

**TUI em PTY**

| Capability | claude-code | gemini-cli | codex | opencode | kimi-code | hermes | antigravity | cursor |
|---|---|---|---|---|---|---|---|---|
| `start` | S | S | S | S | S | S | S | S |
| `send` | S | S | S | S | S | S | S | S |
| `steer` | ? | ? | ? | ? | ? | ? | ? | ? |
| `interrupt` | U | U | U | U | U | U | U | U |
| `turn_completion` | S | ? | S | ? | ? | ? | ? | ? |
| `tool_events` | S | U | S | U | U | U | U | U |
| `question` | S | ? | S | S | ? | ? | ? | ? |
| `approval` | U | U | U | U | U | U | U | U |
| `child_spawn` | U | U | U | U | U | U | U | U |
| `child_result` | U | U | U | U | U | U | U | U |
| `child_stop` | U | U | U | U | U | U | U | U |
| `resume` | S | S | S | S | ? | S | U | U |
| `compact` | S | U | U | U | U | U | U | U |
| `goal` | U | U | U | U | U | U | U | U |
| `checkpoint` | S | S | S | S | S | S | S | S |
| `rollback` | S | S | S | S | S | S | S | S |
| `usage` | S | U | S | S | U | U | ? | U |
| `event_source` | S | S | S | S | S | S | S | S |
| `ags_mcp` (extra) | S | U | S | S | U | ? | U | U |

### 1.3 Contagem

São 22 colunas (6 de conversa, 8 da Frota, 8 de TUI) × 18 capabilities = **396 células**: **163 `Supported`, 29 `Unknown`, 204 `Unsupported`**. Há ainda 22 células `ags_mcp` (fora das 396): 10 `Supported`, 3 `Unknown` e 9 `Unsupported`. O teste `a_contagem_do_doc_concorda_com_a_matriz` falha se esta tabela e `matrix.rs` divergirem.

<!-- contagem-matriz:inicio -->
| Superfície | Provider | Supported | Unknown | Unsupported | `ags_mcp` |
|---|---|---|---|---|---|
| Chat | claude-code | 13 | 2 | 3 | Supported |
| Chat | codex | 14 | 0 | 4 | Supported |
| Chat | opencode | 8 | 1 | 9 | Supported |
| Chat | antigravity | 8 | 0 | 10 | Supported |
| Chat | cursor | 7 | 0 | 11 | Unsupported |
| Chat | local-acp | 6 | 3 | 9 | Unknown |
| Fleet | claude-code | 10 | 0 | 8 | Supported |
| Fleet | gemini-cli | 8 | 0 | 10 | Unsupported |
| Fleet | codex | 9 | 0 | 9 | Supported |
| Fleet | opencode | 9 | 0 | 9 | Supported |
| Fleet | kimi-code | 7 | 0 | 11 | Unsupported |
| Fleet | hermes | 0 | 0 | 18 | Unsupported |
| Fleet | antigravity | 8 | 2 | 8 | Unknown |
| Fleet | cursor | 0 | 0 | 18 | Unsupported |
| Tui | claude-code | 11 | 1 | 6 | Supported |
| Tui | gemini-cli | 6 | 3 | 9 | Unsupported |
| Tui | codex | 10 | 1 | 7 | Supported |
| Tui | opencode | 8 | 2 | 8 | Supported |
| Tui | kimi-code | 5 | 4 | 9 | Unsupported |
| Tui | hermes | 6 | 3 | 9 | Unknown |
| Tui | antigravity | 5 | 4 | 9 | Unsupported |
| Tui | cursor | 5 | 3 | 10 | Unsupported |
| **Total** | 22 colunas × 18 = 396 células | 163 | 29 | 204 | |
<!-- contagem-matriz:fim -->

Fora da tabela estática: TUI custom e ACP custom herdam só o que a pessoa declarou (`agents/adapter.rs:262-274`); `bash` não é agente.

### 1.4 O que falta provar (`Unknown`)

Cada linha é uma pendência de prova, não uma promessa. Colunas iguais estão agrupadas.

| Onde | Capability | O que falta provar |
|---|---|---|
| chat/claude-code | `compact` | captura real recebendo `/compact` como linha `user` e o evento que marca a conclusão |
| chat/claude-code | `goal` | evento do Claude com o status do objetivo e prova de que `/goal` como linha `user` é executado |
| chat/opencode | `resume` | a captura de handshake existe, mas o replay não a ingere: a bancada só lê a resposta de id 2, e nela o `session/resume` de sessão inexistente é `-32602`; `session/new` (id 4) cria a sessão. Falta casear o id que o ADE enviou, e um turno de modelo |
| chat/local-acp | `approval`, `usage`, `ags_mcp` | captura de um agente ACP local real (pedido de permissão, resposta do `session/prompt`, ferramentas `ags`) |
| chat/local-acp | `resume` | o descritor de sessão ler `agentCapabilities` do `initialize` |
| fleet/antigravity | `question`, `approval`, `ags_mcp` | perfil gerado para uma tarefa real (ferramentas `ags`) e um pedido `request-review` sem terminal |
| tui/* (8 CLIs) | `steer` | teste manual em instância isolada, **com OK do usuário**: a TUI enfileira ou interrompe o texto digitado no meio do turno? |
| tui/gemini-cli, opencode, kimi-code, hermes, antigravity, cursor | `turn_completion` | algum marcador de fim de turno no transcript ou no protocolo; hoje só há silêncio de 3 a 5 s |
| tui/gemini-cli, kimi-code, antigravity, cursor | `question` | taxa de falso positivo do regex de tela, medida em capturas reais |
| tui/hermes | `question` | confirmar a ferramenta ask_user visível numa sessão Hermes real |
| tui/kimi-code | `resume` | a flag de retomada do Kimi e se ele informa o id da sessão |
| tui/antigravity | `usage` | uma fonte de uso por sessão (hoje há medidor por conta) |
| tui/hermes | `ags_mcp` | listar as ferramentas `ags` numa sessão Hermes real |

### 1.5 Duas leituras que a matriz exige

**Filho nativo × filho do ADE.** Os inventários misturavam duas rotas sob o mesmo nome. Este contrato separa:
- `child_*` (entre as 18) vale para o filho **nativo do provider**: subagente que o próprio modelo cria. O ADE só o observa.
- O filho **do ADE** (conversa filha por `chat_new`, tarefa da Frota por `delegate_task`/`run_plan`) é criado, acompanhado e parado por serviços do ADE, para qualquer provider. Do provider só se exige uma coisa: o agente consegue chamar as ferramentas `ags`? Isso é a linha `ags_mcp`.

| Nó do ADE | Criar | Resultado | Parar |
|---|---|---|---|
| conversa filha (`child_chat`) | `chat_new` com `client_request_id` (`ipc/commands/conversas.rs:225-268`, recibo em `conversa/api.rs:339-384`) | `chat_wait`/`chat_show` (`conversas.rs:357-388`); aviso do time com o último parágrafo (`chat_team/watch.rs:467-486`) | `chat_stop`: interrompe o turno da filha (`conversa/api.rs:1051-1108`) |
| tarefa da Frota (`fleet_task`) | `delegate_task`, `run_plan`, `task_add` (`runs/orchestration.rs`) | `run.result`, `await_run` (`runs/orchestration.rs:971-1027`, `:1071-1181`) | `cancel_task`: subárvore dentro do run; nunca o lead, nunca filhos de chat (`runs/orchestration.rs:1278-1330`) |

Nenhuma das duas rotas entrega o resultado ao pai de forma durável: é consulta ou aviso. A entrega durável é da Fase 4.

**Retomada automática de tarefa na Frota × Hand-off manual para aba (`resume`).** O §1.1 define `resume` como: a sessão nativa volta depois de reiniciar o app. Na Frota, o boot do app faz varredura (`store.rs:1256-1300`) e marca tarefas `ready`/`running` como `failed`, não havendo relançamento ou retomada automática da tarefa (`Unsupported`). Há, contudo, uma tensão com essa definição: `run_hand_off_task` (`runs/mod.rs:1116-1157`) reabre a sessão nativa numa aba com `--resume`, o que é hand-off manual ao usuário em terminal interativo, e não retomada da tarefa depois de reiniciar o app.

**Escopo das superfícies.** `checkpoint` e `rollback` valem **só para arquivos** na Frota (ref oculta, `runs/checkpoints.rs:113-151`) e nas abas de TUI (`tab_checkpoints/`). Nenhuma superfície volta a conversa do provider. Na conversa estruturada as duas são `Unsupported`.

### 1.6 Divergências que este contrato corrigiu nos inventários

| # | Inventário | Afirmação | O que o código mostra | Efeito na matriz |
|---|---|---|---|---|
| D1 | `cursor-replay` §1.1 #12 | `resume::open_resuming` "só Claude e Codex" | Também o OpenCode: `claude.rs:190`, `codex.rs:285`, `opencode.rs:231`. Cursor e Antigravity **não** usam `open_resuming` e não devem: têm um processo por turno e o prompt sai junto com `--resume`/`--conversation`. Usam `resume::run_turn_resuming` (`cursor.rs:243-267`, `agy.rs:224-248`, `resume.rs:176-199`), que só recai numa sessão nova com prova de recusa antes do turno (§11.12) | Inventário errado no ponto. A célula de `resume` de cursor e agy cita o guarda e os testes dele |
| D2 | `claude-codex` §1 #3 e plano §3 | `mark_unknown_outcomes` "não roda no fim normal" | **Parcialmente certo**, depende do motor: tabela em §1.7 | Registrado em §1.7. Depois da Fase 3, as células de Claude (`tool_events`) e de Codex (`turn_completion`) citam a correção; o estado delas não muda |
| D3 | UI `chatModel.ts:74-80` × inventário | A UI anuncia `midTurn: steer` para o Claude; o inventário diz `unknown` | O Claude só escreve a linha `user` no stdin com o turno aberto (`claude.rs:570-578`) e não observa o desfecho. O comentário da própria UI admite "ou logo depois" (`chatModel.ts:66-67`) | `chat/claude-code` `steer` = `Unknown`; decisão em §1.8 |
| D4 | `claude-codex` §2.1 #9-#11, §2.2 #9-#11 | `child_spawn`/`child_result` `supported` pela rota do ADE (`chat_new`, `chat_wait`) e `child_stop` pela rota nativa (`stop_task`) | Duas rotas misturadas na mesma capability | Separadas (§1.5). Claude: `child_spawn` fica `S` (nativo observado: `tarefas.rs:1-20`), `child_result` vira `U` (o resumo só vai à janela; o log só guarda id, título e status, `execution_log.rs:228-230`), `child_stop` fica `S`. Codex: `child_spawn` `S`, `child_result` `U`, `child_stop` `U` |
| D5 | `antigravity-t3` §1.1 | `child_spawn` e `child_result` = `unknown` | O adapter só mapeia o **nome** da ferramenta para um cartão `Task` (`agy_map.rs:331-334`), igual ao Cursor (`cursor_map.rs:298-300`), que o inventário do Cursor marcou `unsupported`. O inventário do agy afirma que o CLI tem subagente nativo sem citar prova | `Unsupported` nos dois, pela mesma regra (sem caminho no ADE). Não prova que o agy não tenha subagente |
| D6 | `tui-acp-frota` §3 e §4 | `child_*` `supported` na Frota e na TUI | Era a rota do ADE por MCP (`supports_orchestration`), não evento de filho do provider. Os adapters da Frota não emitem evento de filho (`runs/supervisor.rs:444-481`); a TUI só lê transcript de Claude e Codex (`canal/mod.rs:36-39`) | Frota e TUI: `child_*` = `U`, exceto TUI Claude e Codex = `?`. A rota do ADE vai para `ags_mcp` |
| D7 | `tui-acp-frota` §3 | Frota Antigravity `child_spawn` = `S` | Depende do mesmo MCP que o próprio inventário marca como não verificado para `ask_user` (`runs/supervisor.rs:270-276`) | `ags_mcp` do Antigravity na Frota = `Unknown` |
| D8 | `tui-acp-frota` §5.2 | O boot da Frota leva `ready`/`running` a `failed` | Também leva `pending` a `cancelled` com o texto "o app foi fechado antes de chegar a vez dela de rodar" (`runs/store.rs:1304-1316`) | Entra na tabela de estados (§3.2) |
| D9 | `tui-acp-frota` §5.1 | "98 pontos" de inferência por nome | Não reproduzível por comando: contou blocos de linhas e excluiu parte do registro | Substituído pela contagem reproduzível de §6.1 |
| D10 | `tui-acp-frota` §3 (nota) × `adapter.rs` | (confirmado) o flag `Capabilities.mcp` do Antigravity é `true` | Confirmado: `adapter.rs:55` faz `has_task_mcp` seguir `supports_orchestration`, e o registro tem `McpStyle::None` (`registry.rs:384`). O flag contradiz a fonte | Anotado em `ags_mcp` de `tui/antigravity` |

Conferido e **mantido** dos inventários: `Engine::of(...) != Some(Engine::Claude)` decide `NO_TASK_STOP` por nome (`api.rs:1132`); o Codex não chama `pool::after_turn` no `turn/completed` (`codex.rs:567-582`, já documentado em `BANCADA_MOTORES.md:113`); `unreachable!` em `api.rs:840`, `:953` e `:989`; só a primeira pergunta de um formulário recebe resposta.

### 1.7 `mark_unknown_outcomes` por motor (resolve D2)

A função marca como "desfecho desconhecido" as ferramentas `Running` de um turno (`conversa/turn.rs:70-80`, que chama `mark_unknown_outcomes_except`; as exceções vêm do motor). Quem a chama:
- `turn::record_end`, quando `result.interrupted || result.error.is_some()` (`turn.rs:59-61`): os motores de `turn::finish` (OpenCode, Antigravity, Cursor e a queda do Codex);
- `claude::gravar_fim`, em **qualquer** fim do turno do Claude (`claude.rs:455-471`), com as exceções da regra abaixo;
- `codex::gravar_fim`, no `turn/completed`, com **qualquer** `status` (`codex.rs:539-549`);
- `close_orphan_runs`, no boot, só para turnos ainda `inProgress` (`conversa/store.rs:1068-1082`).

| Motor | Fim pelo protocolo | Queda do processo com turno aberto | Boot |
|---|---|---|---|
| Claude | `Out::Done` → `finish_turn` (`claude.rs:440-453`) → `gravar_fim`: **marca** em `result` normal, interrompido ou com erro, **exceto** as tarefas em segundo plano com o processo vivo | `closed()` → `finish_turn` (`claude.rs:368`), sem exceção: **marca tudo** | marca |
| Codex | `turn/completed` → `gravar_fim` (`codex.rs:539-549`): **marca em qualquer `status`**. Não roda `pool::after_turn`, como antes | `closed()` → `turn::finish` (`codex.rs:480`): marca (queda é erro; fechar de propósito é interrupção) | marca |
| OpenCode | `turn::finish` (`opencode.rs:814`): marca se interrompido ou com erro. **Não** marca no fim normal | `turn::finish` (`opencode.rs:589`): marca | marca |
| Antigravity | `turn::finish` (`agy.rs:213`): idem | idem (EOF sem `result` vira erro) | marca |
| Cursor | `turn::finish` (`cursor.rs:225`): idem | idem | marca |

**Exceção das tarefas em segundo plano (Claude).** O evento `task` de começo com `is_backgrounded: true` diz qual `tool_use` a lançou (`tool_use_id`). `tarefa_em_segundo_plano` (`claude.rs:473-480`) guarda esse id em `Session.background`. Com o processo vivo, o fim do turno não marca esse item: o desfecho dele vem pelo canal de tarefas (`task_notification`, ou o `stop_task` que encerra a tarefa). A exceção vale para a tarefa viva e para a já encerrada, porque nos dois casos o desfecho já chega pelo canal. Se o processo cai ou é fechado, nenhuma exceção vale: o canal morre com ele, e o item fica marcado. O Codex não precisa dessa exceção: `collabAgentToolCall` e `subAgentActivity` não viram item da timeline, só vão ao painel de tarefas.

Lacunas reais, em ordem de risco:
1. **OpenCode, Antigravity e Cursor, no fim normal**: não marcam quando o turno acaba **sem erro** (`turn::finish` → `record_end`, `turn.rs:59-61`, só age em erro ou interrupção). Claude e Codex foram corrigidos nesta fase. Para os três, a decisão falta (§8): a premissa de que "os outros motores já marcam no fim normal" não se confirma no código.
2. Não há captura real que mostre `tool_use` sem `tool_result` num fim normal do Claude, nem `commandExecution` `inProgress` no `turn/completed` do Codex. As fixtures `claude-tool-sem-resultado` e `codex-tool-sem-resultado` são sintetizadas: provam o que o código faz com essa entrada, não que a CLI real a produz.
3. Tarefa em segundo plano que acaba sem `tool_result` continua `Running` na timeline: o ADE sabe que a tarefa acabou, mas não fecha o item. Já era assim e não muda aqui.
4. Os itens marcados por `record_end` (OpenCode, Antigravity, Cursor e a queda do Codex) não são emitidos à janela: a tela só os vê ao recarregar. Gap antigo, fora desta fase.

### 1.8 Conflito do `steer` do Claude: decisão

- **A matriz marca `Supported`, com limite.** Em turno com ferramenta a mensagem entra depois da fronteira da ferramenta (`claude-steer-ferramenta`). Em turno sem ferramenta a resposta corrente não muda e a mensagem vira um novo turno logo depois do `result` (`claude-steer-sem-ferramenta`): o primeiro `result` não traz `STEER_OK`; o segundo, na mesma sessão, traz.
- **A declaração `MidTurnBehavior::Steer` (`api.rs:88`) e a cópia `PROTOCOL_AGENTS` (`chatModel.ts:76`) ficam como estão.** Esta tarefa não muda comportamento nem UI.
- Um teste (`o_steer_do_claude_fica_unknown_ate_haver_captura_real`) fixa o texto da observação. Outro (`a_matriz_do_chat_concorda_com_o_contrato_declarado_do_motor`) amarra a tabela a `Engine::capabilities()`: `mid_turn = Steer` exige `steer != Unsupported`; `Interrupt` exige `Unsupported`; o mesmo para `compact` e `goal`.
- A cópia da tela, que promete só "entra no turno em andamento", continua decisão de produto (§8): a captura sem ferramenta mostra o outro destino.

## 2. Modelo de identidade

### 2.1 O que existe hoje

| Identidade | Quem gera | Onde fica | Observação |
|---|---|---|---|
| conversa | ADE, uuid (`conversa/api.rs:311`) | `chat_thread.id` | chave de tudo |
| turno | ADE (Claude, agy, cursor) ou provider (Codex) | `chat_run(thread_id, id)` | **chave composta**: o id não é único entre conversas |
| sessão nativa | provider | `chat_thread.remote_id`; histórico por agente em `chat_thread_native` (`conversa/troca.rs:26-35`) | Claude `session_id`, Codex `thread.id`, agy `conversation_id`, Cursor `session_id`, ACP `sessionId` |
| run da Frota | ADE | `runs.id`; origem em `runs.source_thread_id` (`schema.rs:1359-1365`) | liga à **conversa**, não ao turno |
| tarefa / tentativa | ADE | `tasks.id` (pai em `tasks.parent_id`), `run_attempts.id` | `session_id` do provider em `tasks`/`run_attempts` |
| conversa filha | ADE | `chat_thread.parent_ref = thread:<pai>` e `parent_turn_id` | o turno que a originou é o ativo no instante da criação (`conversa/store.rs:284-352`) |
| recibos | ADE | `chat_child_receipts` (`conversa/store.rs:180`) e `run_delegation_receipts` (`database/schema.rs:1371`) | já existem; o trabalho futuro é **unificar**, não criar |
| nó da árvore | projeção em memória; **desde a Fase 1, linha só para o que originou filho** (`harness_node`) | `thread:<id>`, `turn:<thread>:<turn>`, `run:<id>`, `task:<id>`, `attempt:<id>` (`runs/harness.rs`) | a projeção parte sempre do registro nativo; a linha só dá o id estável |
| evento semântico | fila assíncrona | `harness_execution_events` (`runs/execution_log.rs:249-270`), única por `(thread_id, dedupe_key)` | guarda `parent_node_id` como texto |

### 2.2 Entidades

**`HarnessRun`.** A identidade ADE de um turno que orquestra trabalho. Um turno do usuário é um `HarnessRun` (invariante 2 do plano). Fim de subagente, de ferramenta ou de filho nunca fecha o run.

| Campo | Papel |
|---|---|
| `id` | uuid ADE, estável |
| `thread_id`, `turn_id` | o turno raiz, em par (`chat_run`); único por par |
| (Fase 3+) `end_source`, `end_reason`, `outcome_unknown`, `ended_at` | como e por que o root acabou |

**`ExecutionNode`.** Uma unidade de trabalho dentro de um run.

| Campo | Papel |
|---|---|
| `id` | uuid ADE, estável; é a identidade de comando e de lineage |
| `run_id`, `parent_id` | relação durável; `parent_id` é nulo só no root **do run**. A raiz do run de uma conversa filha também tem `parent_id` nulo: o elo "esta conversa é filha de tal nó" fica em `child_chat` do run do pai, e a projeção o reconstrói por `parent_ref`/`parent_turn_id` |
| `kind` | Fase 1: `root_agent`, `child_chat`, `fleet_run`, `fleet_task`. Reservados: `fleet_attempt`, `tool_call`, `approval`, `question`, `native_subagent` |
| `source_kind`, `source_ref` | o registro nativo que o nó representa (`chat_run` `<thread>/<turn>`, `chat_thread`, `fleet_run`, `fleet_task`); único por par |
| `legacy_ref` | o id textual de hoje (`turn:…`, `thread:…`, `run:…`, `task:…`); liga eventos e UI antigos |
| (Fase 3+) `status`, `end_reason`, `outcome_unknown`, `provider_session_id`, tempos | estado e sessão |

**`ProviderSessionRef`** (Fase 3 e 4, fora da fatia da Fase 1). A referência durável à sessão nativa do provider: `provider_id`, `native_kind` (`claude_session`, `codex_thread`, `acp_session`, `agy_conversation`, `cursor_session`, `fleet_session`), `native_id`, `account_id`, estado (`attached`, `resumable`, `lost`) e a evidência de retomada. Não nasce do zero: unifica `chat_thread.remote_id`, `chat_thread_native` e `tasks.session_id`/`run_attempts.session_id`, que continuam sendo a fonte operacional até a migração.

**`ContextTransfer`** (Fase 4). A relação "contexto sai de A e vai para B": `source`, `target` (nó ou conversa), `kind` (`child_brief`, `provider_switch`, `fork`, `merge_back`), `strategy`, estado (`planned`, `materialized`, `consumed`) e `untrusted = 1` sempre. O **payload** (`ContextHandoff`) continua onde está hoje (`conversa/handoff.rs`, `conversa/troca.rs`, o contexto explícito do `chat_new`): a transferência guarda só tamanho, hash e referência, nunca uma cópia do transcript.

### 2.3 Regras de identidade

1. **IDs ADE são a identidade; ids de provider são referência.** Nenhum id de provider vira chave de nó.
2. Todo nó novo recebe um uuid ADE no instante em que o ADE aceita o comando (não quando o provider responde).
3. `source_kind + source_ref` é único: um registro nativo pertence a **no máximo um** nó, logo a no máximo um run.
4. O id composto do turno (`thread_id/turn_id`) nunca é usado sem a conversa: `chat_run.id` colide entre conversas.
5. O `legacy_ref` fica para sempre. Eventos e telas antigos continuam achando o nó por ele.

### 2.4 Relações pai e filho

| Filho | Pai | De onde vem a relação |
|---|---|---|
| conversa filha | nó raiz do turno **pai** que a originou | `parent_ref` + `parent_turn_id` (já gravados). Sem `parent_turn_id` (criada com o pai ocioso, ou por aba TUI), **não há run** e a conversa só aparece na projeção antiga |
| run da Frota | nó raiz do turno que a originou | `runs.source_thread_id` (liga à conversa) e, desde a Fase 1, o nó `fleet_run`, gravado **na mesma transação** que cria o run (`runs/orchestration.rs`, depois de `set_run_source_thread`). O turno é o `inProgress` único lido dentro dessa transação por `conversa::store::active_turn_id` |
| tarefa da Frota | nó do run da Frota, ou da tarefa pai (`tasks.parent_id`) | `tasks.run_id`, `tasks.parent_id` |
| tentativa | nó da tarefa | `run_attempts.task_id` (projetada na Fase 1; vira nó depois) |
| ferramenta, aprovação, pergunta, subagente nativo | nó que os emitiu | Fase 3, quando o adapter expõe |

### 2.5 Como chat e Frota mapeiam sem cruzar id nem cwd

| Domínio nativo | Nó | Chave de ligação |
|---|---|---|
| `chat_thread` raiz + `chat_run` | `HarnessRun` + nó `root_agent` | `(thread_id, turn_id)` |
| `chat_thread` filha | `child_chat` | `chat_thread.id` (`source_ref`) |
| `runs` com `source_thread_id` | `fleet_run` | `runs.id` |
| `tasks` | `fleet_task` | `tasks.id` |
| `run_attempts` | `fleet_attempt` (depois) | `run_attempts.id` |

Regras de não cruzamento (cada uma vira teste na Fase 1):
- **A relação é sempre por id gravado, nunca por `cwd`.** A projeção atual já não junta por pasta (`runs/harness.rs:96-292`); o contrato fixa isso. Duas conversas na mesma pasta e dois runs na mesma pasta não se misturam.
- **O `cwd` fica como atributo do registro nativo.** A tarefa da Frota tem pasta e worktree próprios (`tasks.cwd`); a conversa filha tem o dela. O nó não copia `cwd`.
- **Um run da Frota sem `source_thread_id`** (CLI ou MCP fora de conversa) **não** vira nó na Fase 1. Continua visível só pela Frota.
- **Um run da Frota criado sem turno ativo** na conversa (por exemplo, depois do fim do turno) também não vira nó: não há turno para pendurar.

### 2.6 O que adotar do T3

Fonte: inventário `antigravity-t3.md`, que cita o `main` móvel de `pingdotgg/t3code`. **Não foi revalidado nesta tarefa** (sem acesso de rede). O README de `orchestration-v2` diz que o desenho ignora migração e compatibilidade. O ADE **não pode**: migração só aditiva (`AGENTS.md` §2.3).

| Conceito do T3 | Decisão | Por quê |
|---|---|---|
| `AppThread → Run → ExecutionNode` | **Adotar** como `chat_thread → HarnessRun → ExecutionNode` | É o que o plano já pede; só os nomes mudam |
| `ProviderSession` (processo vivo) separado de `ProviderThread` (conversa nativa) | **Adotar a separação no vocabulário; persistir só a conversa nativa** (`ProviderSessionRef`). O processo fica como **instância** (escopo `instance`), só em memória | No ADE o processo não sobrevive ao app: os da Frota são filhos do app (`runs/store.rs:1249-1252`) e os de conversa morrem com ele (`opencode.rs:494`, `kill_on_drop`). Persistir um "runtime recuperável" prometeria o que não existe |
| `ContextTransfer` (relação, barata, preguiçosa) separado de `ContextHandoff` (payload materializado) | **Adotar** | O ADE já tem três materializações sem registro comum: resumo de troca de agente (`handoff.rs`/`troca.rs`), contexto do `chat_new` e entrega da Frota. A relação com política e consumo rastreável falta; o payload já existe e não deve ser copiado |
| Outbox durável de efeitos | **Não é pré-requisito da Fase 1.** O T3 a trata como "Tracked Follow-Up", fora da primeira fatia | A Fase 1 não precisa de outbox. A Fase 2 entrega a fila de efeitos com claim e lease (§11); o **worker contínuo** só entra quando a Fase 5 provar a necessidade |
| Receipts idempotentes | **Reaproveitar o que há** (`chat_child_receipts`, `run_delegation_receipts`) e unificar na Fase 2 | Os dois já têm `caller_key + request_id + request_hash`, mesma forma de chave |
| Estados de nó (`pending`, `running`, `waiting`; `completed`, `interrupted`, `failed`, `cancelled`, `rolled_back`) | **Adotar com acréscimos** (§3) | O ADE tem `skipped` e `handed_off` na Frota. `rolled_back` fica reservado: nenhuma capability de conversa o sustenta |
| Só o nó raiz conclui o run | **Adotar** | É a invariante 2 do plano (§3.3) |

## 3. Máquina de estados

### 3.1 Vocabulário do nó

| Tipo | Estados |
|---|---|
| **Não terminais** | `pending`, `running`, `waiting` |
| **Terminais** | `completed`, `failed`, `cancelled`, `interrupted`, `skipped`, `handed_off` |
| Reservado (não usar ainda) | `rolled_back` |

Atributos que **acompanham** um terminal (não são estados):
- `end_reason`: `adapter_final`, `adapter_quiet_final`, `process_drop`, `user_stop`, `app_closed`, `scheduler_cancel`, `dependency_failed`, `unmapped_native_status`;
- `outcome_unknown` (booleano): o ADE não consegue provar o efeito de uma ferramenta ou de um envio.

Diferenças de significado:
- `interrupted`: parada sem erro do agente (a pessoa parou, o app fechou, o processo foi fechado de propósito, reconciliação no boot).
- `cancelled`: o scheduler ou a pessoa cancelou uma tarefa ou subárvore da Frota.
- `failed`: erro do agente ou do processo.
- `skipped` e `handed_off` só existem na Frota (`runs/types.rs:113-131`).

### 3.2 Mapa do estado nativo para o nó

| Nativo | Nó | Observação |
|---|---|---|
| `chat_run.inProgress` | `running` | `waiting` se houver `chat_request.pending` do nó |
| `chat_run.completed` | `completed` | |
| `chat_run.failed` | `failed` | |
| `chat_run.interrupted` | `interrupted` | |
| `chat_run.status` com outro texto (o Codex grava o `turn.status` como veio, `codex.rs:573-574`) | `interrupted`, `end_reason = unmapped_native_status`, `outcome_unknown` | nunca promover um valor desconhecido a terminal conhecido |
| `tasks.pending`, `ready` | `pending` | |
| `tasks.running` | `running` | |
| `tasks.done` | `completed` | |
| `tasks.failed` com `error = SWEPT_RUNNING_ERROR` | `interrupted`, `end_reason = app_closed` | estado vira `interrupted` (`runs/harness.rs:294-295, 321-323`); `end_reason` ainda não existe na projeção (Fase 3) |
| `tasks.failed` (outro erro) | `failed` | |
| `tasks.cancelled` | `cancelled` | no boot, `pending` vira `cancelled` com texto próprio (`runs/store.rs:1304-1316`) |
| `tasks.handed_off` | `handed_off` | a pessoa assumiu numa aba |
| `tasks.skipped` | `skipped`, `end_reason = dependency_failed` | |
| `runs.running` | `running` | `runs.status` é derivado das tarefas por `refresh_run` (`runs/store.rs:772-800`) |
| `runs.done`, `failed`, `cancelled` | `completed`, `failed`, `cancelled` | **cuidado:** um run só com `handed_off` (sem `failed` nem `skipped`) cai em `cancelled`. O contrato não corrige; só registra |
| `run_attempts.*` | igual ao da tarefa | mesmo vocabulário |
| conversa filha | o nó vale o estado do **último turno** da filha; sem turno, `pending` | `chat_thread.state` (`active`/`settled`) não é estado de execução |

### 3.3 Regras

1. **Só o root encerra o run.** O run é terminal se, e só se, o nó raiz é terminal. Filho, ferramenta, aprovação ou pergunta terminando (ou falhando) nunca fecha o run.
2. **O root só vira terminal por uma destas quatro causas:**
   - evento final do adapter do root (`result`, `turn/completed`, resposta do `session/prompt`, `result` do agy ou do cursor);
   - queda do processo com turno aberto (`turn::dropped`, `turn.rs:201-211`);
   - Parar da pessoa;
   - reconciliação no boot, **marcada** com `end_reason = app_closed`.
3. **O que NÃO é terminal** (e o harness não pode tratar como fim):
   - processo ocioso ou `phase: idle` com turno ainda aberto;
   - silêncio de tela, em qualquer TUI;
   - o aviso `turnTimeout` do chat_team, que só avisa (`conversa/turn.rs:181-191`);
   - fim de ferramenta, de subagente ou de filho;
   - pedido de aprovação ou de pergunta pendente.
4. **Cursor é exceção declarada.** O adapter fecha o turno por silêncio depois da última chamada do modelo (10 s), depois de fala (3 min) ou por silêncio duro (15 min, com erro) (`cursor_map.rs:40-46`). Isso é um **final definido pelo adapter**: vale como `adapter_quiet_final`, nunca como regra para outros motores. Não há captura real que o confirme.
5. **Turno sem sinal de fim e processo vivo fica `running`.** Não há prazo de turno em nenhum motor de conversa. O harness não inventa um fim.
6. **`waiting`.** Um nó está `waiting` enquanto tiver pedido de pergunta ou aprovação pendente que ele possui. O pai continua `running` e **enxerga o bloqueio**: a projeção sinaliza "precisa da pessoa" em quem tem descendente `waiting`. Quem decide é a pessoa, nunca o pai.
7. **Filho termina antes do pai:** permitido e esperado. O resultado do filho chega ao pai como dado não confiável, e o pai não falha por causa dele.
8. **Pai termina antes do filho:** permitido. O filho da Frota continua vivo depois do fim do turno do pai, e o turno não espera. O contrato distingue:
   - run **terminal**: o root acabou;
   - run **assentado**: todos os nós são terminais.
   O nó de turno da projeção traz `activeChildren`: quantos filhos diretos ainda não são terminais. Filho direto é quem tem esse turno como `parentId` — a conversa filha ou o run da Frota. Um run da Frota conta uma vez, não cada tarefa. A conversa filha vale o estado do último turno dela (§3.2); sem nenhum turno, ela é `pending` no nó, mas **não conta como ativa**: uma conversa lateral aberta e nunca usada mostraria "1 filho ativo" para sempre. `chat_thread.state` não entra. O mapa é `harness::state` (`interrupted`, `failed`, `cancelled`, `completed`, `skipped` e `handed_off` são terminais). Run legado sem nó e sem turno pai não entra. Não há coluna nem estado novo: a contagem é derivada na leitura e os outros nós omitem o campo. Quando o turno está terminal e a contagem é maior que zero, a árvore mostra "N filhos ativos" junto do status; o ponto de status continua o do turno. A mesma projeção chega à CLI (`run.harnessGraph`) e ao MCP (`harness_graph`), então o campo aparece lá sem comando novo. Decisão do usuário; o item 4 de §8 fica fechado.
9. **Cancelamento.** Cancelar o root é parar o turno dele. Descendentes só são cancelados por ordem do pai ou da pessoa, com escopo verificado (Fase 4). Parar uma conversa filha interrompe o turno dela; cancelar na Frota age na subárvore do run, nunca no lead nem em filhos de chat (`runs/orchestration.rs:1278-1330`). Nunca se encerra o PTY original de uma sessão conectada.

### 3.4 Reinício do app

O que já acontece (e o contrato mantém):
- **Conversa** (`conversa/store.rs::sweep_orphans`, chamado em `database/connection.rs:159`): turno `inProgress` vira `interrupted`; ferramentas sem resultado ganham `TOOL_OUTCOME_UNKNOWN`; pedidos `pending` viram `expired`; tudo numa transação. Nunca reenvia nada.
- **Frota** (`runs/store.rs::sweep_orphans`, chamado em `app/housekeeping.rs:51`): `ready` e `running` viram `failed` com `SWEPT_RUNNING_ERROR`; `pending` vira `cancelled`; o status do run é recalculado. Não relança.
- As duas varreduras só rodam se `ipc::other_instance_alive()` for falso. Isso é uma checagem, não um lock: a serialização entre instâncias é da Fase 5 e **não está provada**.

O que o contrato acrescenta (Fases 3 e 5, não agora):
- Todo nó não terminal vira `interrupted` com `end_reason = app_closed` **na mesma transação** da varredura nativa. A reconciliação fica explícita: `end_source = reconciliation`.
- `outcome_unknown = 1` quando havia ferramenta `Running`, ou envio em `submitting`/`unknown` (`chat_child_receipts.delivery_state`).
- Nó `waiting` vira `interrupted`: o processo que esperava a resposta morreu e o pedido expirou. Não se retoma uma aprovação.
- **"Retomar" nunca altera o histórico.** Cria uma nova attempt correlacionada ao nó antigo, escolhida pela pessoa. Só existe onde a capability `resume` for `Supported` e provada.

## 4. Plano de migração aditiva

### 4.1 Princípios

- **Só `CREATE TABLE IF NOT EXISTS` e `ALTER TABLE … ADD COLUMN` protegido por `has_column`.** Nada é apagado, renomeado ou reinterpretado. O que não migra vira `_legacy_*` (`docs/agentes/BACKEND.md`).
- **Sem `CHECK` de enumeração** nas tabelas novas. O SQLite não altera `CHECK`: um `kind IN (…)` fixo obrigaria reconstruir a tabela quando surgir um tipo de nó. Os valores são validados em Rust.
- **O estado nativo continua sendo a fonte de verdade** até cada coluna de estado nova ser provada igual a ele. Em divergência, o nativo vence.
- **Schedulers e bancos atuais ficam como estão:** o scheduler da Frota (`runs/`), as tabelas `chat_*`, `runs`, `tasks`, `run_attempts` e os dois recibos. O harness lê, relaciona e, só depois, escreve estado.
- **As tabelas novas nascem num `migrate()` de módulo**, como `harness_execution_events` (`runs/execution_log.rs:247`), chamado de `conversa::store::migrate`. Assim `database/schema.rs` e `ipc/protocol.rs` não mudam. Esses `migrate()` próprios ficam **fora** do alvo do fingerprint (`docs/decisoes/FINGERPRINT.md`), por isso a mudança não pede registro novo.
- Apagar uma conversa apaga em cascata só as linhas `harness_*` dela (mesmo padrão de `chat_item`). As linhas da Frota (`runs`, `tasks`) não são tocadas (`runs.source_thread_id` vira `NULL`: `ON DELETE SET NULL`).
- O CASCADE de `harness_run.thread_id` só cobre apagar a **raiz** do run. Um nó cuja origem é outra linha (`child_chat` → `chat_thread`; `fleet_run` → `runs`; `fleet_task` → `tasks`) guarda a origem como texto, sem FK. Por isso a migração cria **gatilhos `AFTER DELETE`** nessas três tabelas que removem o nó na mesma operação, inclusive nas deleções por CASCADE (conferido por teste). Hoje só `conversa::store::delete_side_chat` apaga `chat_thread`, e nada apaga `runs`/`tasks` além do CASCADE do workspace; os gatilhos cobrem rotas futuras sem depender de cada chamador. A projeção, de qualquer forma, parte do registro nativo e nunca mostra nó sem origem.

### 4.2 DDL proposto (Fase 1)

Aplicado na Fase 1 por `harness::store::migrate`, chamado no fim de `conversa::store::migrate` (depois de `chat_thread` e, no schema real, de `runs` e `tasks`). Além das duas tabelas, o `migrate` cria três gatilhos de limpeza (§4.1); eles não fazem parte do texto abaixo.

```sql
CREATE TABLE IF NOT EXISTS harness_run (
    id          TEXT PRIMARY KEY,                -- uuid ADE
    thread_id   TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE,
    turn_id     TEXT NOT NULL,                   -- chat_run.id do turno raiz
    created_at  INTEGER NOT NULL,
    UNIQUE (thread_id, turn_id)
);

CREATE TABLE IF NOT EXISTS harness_node (
    id          TEXT PRIMARY KEY,                -- uuid ADE
    run_id      TEXT NOT NULL REFERENCES harness_run(id) ON DELETE CASCADE,
    parent_id   TEXT REFERENCES harness_node(id) ON DELETE CASCADE,  -- nulo só no root
    kind        TEXT NOT NULL,                   -- root_agent | child_chat | fleet_run | fleet_task (validado em Rust)
    source_kind TEXT NOT NULL,                   -- chat_run | chat_thread | fleet_run | fleet_task
    source_ref  TEXT NOT NULL,                   -- chat_run: '<thread_id>/<turn_id>'; os demais: o id nativo
    legacy_ref  TEXT NOT NULL,                   -- 'turn:<t>:<r>' | 'thread:<id>' | 'run:<id>' | 'task:<id>'
    created_at  INTEGER NOT NULL,
    UNIQUE (source_kind, source_ref),
    UNIQUE (legacy_ref)
);
CREATE INDEX IF NOT EXISTS idx_harness_node_run ON harness_node(run_id, parent_id);
```

Sem coluna de estado na Fase 1: o estado do nó é **derivado** do registro nativo pelo par `source_kind/source_ref`, então não há escrita dupla para divergir.

Acréscimos previstos para as fases seguintes, **todos `ADD COLUMN`**:

| Fase | Tabela | Colunas |
|---|---|---|
| 2 | `harness_execution_events` | `node_id TEXT`, `harness_run_id TEXT` (o `run_id` existente é o da Frota: não reaproveitar) |
| 3 | `harness_node` | `status`, `end_reason`, `outcome_unknown INTEGER NOT NULL DEFAULT 0`, `started_at`, `ended_at`, `provider_session_id` |
| 3 | `harness_run` | `end_source`, `end_reason`, `outcome_unknown`, `ended_at` |
| 2 | nova `harness_command_receipt` | `kind`, `caller_key`, `request_id`, `request_hash`, `node_id`, `state`, `event_sequence`; chave `(kind, caller_key, request_id)`. Os dois recibos antigos ficam e são lidos |
| 4 | nova `harness_provider_session` | as colunas de `ProviderSessionRef` (§2.2) |
| 4 | nova `harness_context_transfer` | as colunas de `ContextTransfer` (§2.2) |

### 4.3 Compatibilidade com dados e eventos antigos

- **Nenhuma linha antiga é reescrita.** `chat_thread`, `chat_run`, `runs`, `tasks`, `run_attempts` e os recibos seguem iguais.
- **Sem backfill obrigatório.** Run antigo da Frota e conversa filha antiga não ganham `harness_run`. A projeção antiga (`runs/harness.rs`) continua montando a árvore para eles. A árvore final é a união: nós com linha em `harness_node` usam o `id` estável; os demais continuam com o id textual.
- **Evento antigo sem nó** continua legível: `harness_execution_events` já tem `parent_node_id` em texto e a migração antiga o preencheu (`execution_log.rs:284-296`). A leitura resolve esse texto pelo `legacy_ref`. `node_id` novo fica `NULL` nesses eventos e nunca é preenchido retroativamente à força.
- **Backfill opcional e posterior**, idempotente, por `INSERT … WHERE NOT EXISTS`, só quando houver um ganho claro. Não faz parte da Fase 1.
- **Banco de versão futura:** `PRAGMA user_version` não sobe. As tabelas novas não dependem de versão (`BACKEND.md`: acréscimos aditivos sem subir `user_version`).

### 4.4 Ordem de adoção

| Fase do plano | O que entra | O que continua como está |
|---|---|---|
| 0 (este PR) | contrato, matriz e tipos; **nada no banco** | tudo |
| 1 | `harness_run`, `harness_node`, dois pontos de gravação, projeção unida (§7) | estado derivado do nativo; scheduler e adapters intactos |
| 2 | `node_id` nos eventos; `harness_command_receipt` unificando os recibos; `harness_effect` (fila com lease); evento gravado na transação do comando; erro de gravação deixa de ir só a `stderr` (§11) | os dois recibos antigos, lidos e nunca apagados; sem worker contínuo |
| 3 | colunas de estado em `harness_node`; adapters gravam estado do root nos pontos de fim (§1.7 lista os pontos); nós de ferramenta, aprovação, pergunta e subagente nativo; descritor lido pela UI e pelo MCP | o nativo vence em divergência; `finish_turn` do Claude e `turn/completed` do Codex passam a chamar `record_end` |
| 4 | `connected_session`, `ProviderSessionRef`, `ContextTransfer`, entrega durável do resultado ao pai | `chat_thread_native` e `remote_id` seguem como fonte operacional |
| 5 | reconciliação por nó no boot; serialização entre instâncias; worker com lease **se** a prova pedir | as duas varreduras nativas |

### 4.5 Receipts: unificar, não criar

| | `chat_child_receipts` | `run_delegation_receipts` |
|---|---|---|
| Chave | `(caller_key, request_id)` | `(caller_key, request_id)` |
| Identidade do conteúdo | `request_hash` | `request_hash` |
| Alvo | `thread_id` | `run_id` + `task_keys_json` |
| Estado | `delivery_state`: `prepared`, `submitting`, `accepted`, `retryable`, `unknown` | nenhum (existe ou não) |
| Onde grava | transação `Immediate` de `create_inner` (`conversa/api.rs:339-384`) | transação `Immediate` da delegação (`runs/orchestration.rs:758-870`) |

A Fase 2 adiciona `harness_command_receipt` com `kind`. Leitura passa pela nova tabela e cai nas antigas; escrita é dupla até a nova ser provada. Mesmo `client_request_id` com conteúdo diferente continua falhando fechado.

## 5. Provas de replay por adapter

### 5.1 O que existe

- Cinco fixtures de protocolo `synthesized`: `claude-ferramenta-aprovacao-e-cota`, `codex-comando-falha-e-queda`, `acp-pedido-e-max-tokens`, `claude-tool-sem-resultado` e `codex-tool-sem-resultado` (estas duas cobrem o fim normal com ferramenta sem resultado, sem captura real). Cinco roteiros (cota, retomada, JSON quebrado, stall) para os mesmos três protocolos.
- Onze fixtures `recorded`, gravadas com `record` a partir do stdout sanitizado (2026-11-09): `claude-feliz`, `claude-interrompido`, `claude-steer-ferramenta`, `claude-steer-sem-ferramenta`, `codex-feliz`, `codex-interrompido-real`, `codex-interrupt-antes-do-started`, `antigravity-feliz`, `antigravity-queda`, `cursor-feliz`, `cursor-queda`. `opencode-resume-e-load` não entrou: a bancada só trata a resposta de id 2 como sessão.
- Variantes derivadas no replay (não são novas capturas): `replay_derivado_claude_tool_result_fora_de_ordem` permuta frames de `claude-feliz`; `replay_derivado_codex_started_depois_da_resposta_turn_start` reordena `codex-feliz`; `replay_derivado_antigravity_ferramenta_depois_do_texto` reordena `antigravity-feliz`; `replay_derivado_cursor_ferramenta_depois_do_texto` reordena `cursor-feliz`. `replay_derivado_streams_parciais_ficam_abertos` corta `claude-feliz` e `cursor-feliz` no meio de ferramenta e `codex-feliz` e `antigravity-feliz` no meio do texto. `replay_derivado_processo_ocioso_sem_frame_final_nao_conclui_turno` remove o frame final de cada captura. Cada teste aponta a captura e usa apenas quadros reais, reordenados ou removidos.
- A projeção prova a conclusão antecipada dos dois tipos de filho do ADE em `runs/test.rs::filhos_de_chat_e_frota_terminam_antes_sem_fechar_o_turno_pai`: conversa filha e run da Frota tornam-se terminais; o turno pai continua `inProgress` até o próprio `chat_run` receber o evento final.
- A bancada toca **só a leitura** (o que o provider escreve). As linhas `in` (o que o ADE escreve) são ignoradas (`replay_protocolo.rs:198-210`). Nada prova o que o ADE manda.
- O que o replay **não** vê: o banco. `mark_unknown_outcomes`, `sweep_orphans` e o estado do turno em `chat_run` não aparecem no snapshot. Eles pedem teste de banco (`test_db()`), como `conversa/test.rs:565-597`. A marcação do fim do turno tem os testes de banco de `conversa/test.rs::desfecho_desconhecido`; as fixtures `*-tool-sem-resultado` fixam só a entrada, ou seja, que a ferramenta fica `running` no fim do transcript.

### 5.2 Bloqueios da bancada (conferidos no código)

| # | Bloqueio | Onde | Efeito |
|---|---|---|---|
| B1 | `Protocolo` tinha **3 variantes** | resolvido: `agy-stream` e `cursor-stream` entram no replay | as fixtures recorded dos dois rodam |
| B2 | O snapshot não tem evento de filho, uso nem pedido pendente no fim | resolvido para filhos, pedidos pendentes e tipos (`replay_protocolo.rs:223, 228, 230`); falta apenas `uso` | "uso do turno" ainda não entra no snapshot |
| B3 | O `Motor` da bancada descartava `Task` e `SubItem` | resolvido: o Motor guarda ambos em `filhos` (`bancada.rs:795-796`, `test_bancada.rs:262-282`) | eventos de filho do Claude são preservados |
| B4 | O oráculo não afirmava o tipo do item nem "pedido ainda pendente" | resolvido: `Espera` tem `tipos` e `pedidos_pendentes` (`bancada.rs:947-967`), conferidos pelo oráculo (`bancada.rs:1030-1034`) | oráculo afirma tipos e pedidos que sobram |
| B5 | O guard recusava `ToolKind::Other` | resolvido: lista por protocolo via `other_aceito` (`bancada.rs:1086-1092`), usada em `:530-531` | Cursor aceita `mcp` e agy aceita `denied`, sem afrouxar os outros |
| B6 | O Cursor fecha o turno por **prazo** (`quiet_after`) | resolvido no `read_turn` da bancada | `cursor-feliz` usa o `atMs` da captura, abaixo do silêncio, e o fim é o `result` |

### 5.3 Provas por adapter e prioridade

Prioridade: **P0** protege efeito colateral e fato perdido (é pré-requisito das Fases 2 e 3); **P1** cobre falha comum; **P2** completa. A coluna "como" diz se é fixture de bancada ou teste de banco.

| Cenário | Claude | Codex | OpenCode (ACP) | Antigravity | Cursor | Como |
|---|---|---|---|---|---|---|
| **P0** ferramenta sem resultado ao fim | **feito** (§1.7): fixture `claude-tool-sem-resultado` + teste de banco do `finish_turn` (`gravar_fim`) | **feito**: fixture `codex-tool-sem-resultado` + teste de banco do `turn/completed` (`gravar_fim`) | fixture `acp-tool-sem-resultado` | `requer captura real` | `requer captura real` | Claude e Codex marcam no fim (a fixture fixa a entrada; o teste de banco, o efeito). OpenCode, Antigravity e Cursor ainda não marcam no fim normal (§1.7, lacuna 1) |
| **P0** frame final ausente (EOF) | fixture `claude-sem-result-fecha-no-eof` | fixture `codex-sem-turn-completed` | fixture `acp-sem-result-fecha-no-eof` | **gravada** `antigravity-queda` (kill sem `result`) | **gravada** `cursor-queda` (kill sem `result`) | bancada |
| **P0** reinício no meio do turno | teste de banco: `sweep_orphans` + retomada (`--resume`) | idem (`thread/resume`) | idem (`session/resume`, hoje `Unknown`) | teste do guarda `run_turn_resuming` com fakes (`test.rs:779-901`): recusa antes do turno → turno novo com aviso; o resto não repete | idem (`--resume`, mesmo guarda) | teste de banco por motor (o agnóstico já existe: `test.rs:565-597`) |
| **P1** queda no meio com stderr | fixture `claude-queda-com-stderr` | **já há** `codex-comando-falha-e-queda` | fixture `acp-queda-com-stderr` | `requer captura real` | `requer captura real` | bancada |
| **P1** interrupção | **gravada** `claude-interrompido` | **gravada** `codex-interrompido-real` (e `codex-interrupt-antes-do-started`: `-32600` antes de `turn/started`; o ADE segura o Parar e o manda no aviso: `codex_parar.rs`, `test_codex_parar.rs`) | fixture `acp-interrompido` | o kill gravado não separa interrupt de queda | o interrupt é kill, sem mensagem; ver `cursor-queda` | bancada |
| **P1** pedido pendente no fim do turno | fixture `claude-pedido-pendente-no-fim` | parcial: o pedido existe, mas a fixture termina em queda | parcial: o pedido é respondido | não se aplica (sem pedido) | não se aplica | bancada + teste de banco de `expire_requests` |
| **P1** frames fora de ordem | derivada `claude-feliz` (**quarentena**: `tool_result` antes de `tool_use` é descartado, `claude_map.rs:287-289`) | derivada `codex-feliz`: `turn/started` logo após resposta de `turn/start` | `requer captura real` | derivada `antigravity-feliz`: DONE da ferramenta depois do texto | derivada `cursor-feliz`: conclusão de ferramenta depois do texto | bancada; só reordena quadros registrados |
| **P0** stream parcial (texto/ferramenta) | derivada `claude-feliz`, corte no `tool_use` | derivada `codex-feliz`, corte em `agentMessage/delta` | `requer captura real` | derivada `antigravity-feliz`, corte no delta de texto | derivada `cursor-feliz`, corte no início da ferramenta | bancada; oráculo exige turno `aberto` |
| **P0** processo ocioso sem frame final | derivada `claude-feliz`, sem `result` | derivada `codex-feliz`, conserva `thread/status: idle` e remove `turn/completed` | `requer captura real` | derivada `antigravity-feliz`, sem `result` | derivada `cursor-feliz`, sem `result` | bancada; oráculo exige turno `aberto` |
| **P2** turno feliz | **gravada** `claude-feliz` | **gravada** `codex-feliz` | fixture de base | **gravada** `antigravity-feliz` | **gravada** `cursor-feliz` | bancada |
| **P2** filho termina antes do pai | bancada pronta (B2 e B3 resolvidos); requer fixture | bancada pronta (B2 e B3 resolvidos); requer fixture | sem frame de filho (o ACP só tem o cartão `think`) | `requer captura real` | `requer captura real` | bancada |

Contagem da grade (11 cenários × 5 motores = 55 células): **11 com fixture exata** (a queda sintetizada do Codex, as duas ferramentas sem resultado sintetizadas de Claude e Codex, mais oito recorded: feliz de Claude, Codex, Antigravity e Cursor; interrupção de Claude e Codex; EOF de Antigravity e Cursor), **3 parciais** (pedido em Claude, Codex e ACP), **11 variantes derivadas aprovadas** (três fora de ordem, quatro cortes parciais e quatro processos ociosos), **1 variante derivada em quarentena** (Claude fora de ordem; o resultado anterior a `tool_use` é descartado), **29 sem fixture**. As variantes derivadas não contam como capturas independentes. O steer do Claude (`claude-steer-ferramenta` e `claude-steer-sem-ferramenta`) não é linha desta grade.

### 5.4 O que exige captura real (nunca sintetizar)

- **Queda com stderr** de Cursor e Antigravity. O que há é kill sem `result` e sem stderr (`cursor-queda`, `antigravity-queda`).
- **Interrupt de protocolo** do Cursor e do Antigravity. Os dois matam o processo; a captura não separa isso de uma queda.
- **O que o ADE escreve e o motor não lê** (`/compact`, `/goal`, `turn/steer`): a bancada ignora `in`. O steer do Claude e o `turn/interrupt` do Codex estão no transcript como `in`, e o efeito está nos frames `out`.
- **OpenCode com turno de modelo**, e um replay que leia `session/resume` / `session/load` pelo id que o ADE enviou. A captura de handshake já mostra `-32602` para sessão inexistente e `configOptions` para a sessão nova; não foi importada.
- Capturas gastam a conta e a cota da pessoa e **exigem OK explícito e teto** (§8).

### 5.5 Infraestrutura da bancada (situação atual)

B1 a B6 foram resolvidos pela bancada ampliada:
1. `Espera` e snapshot estendidos com `filhos`, tipo do item e `pedidosPendentes` (B2 e B4 resolvidos em `replay_protocolo.rs:223-230`, `bancada.rs:947-967, 1030-1034`). Falta apenas `uso` no snapshot.
2. `Motor` guarda `Out::Task` e `Out::SubItem` (B3 resolvido em `bancada.rs:795-796`, `test_bancada.rs:262-282`).
3. `Protocolo::AgyStream` implementado (B1).
4. `Protocolo::CursorStream` implementado com `read_turn` (B6).
5. Lista de ferramentas aceitas por protocolo no guard (`other_aceito` em `bancada.rs:1086-1092`, B5 resolvido).

## 6. Inferência de capability por nome

### 6.1 Contagem reproduzível

Comando (linhas brutas, sem arquivos de teste dedicados):

```bash
grep -rn --include='*.rs' -E '"claude-code"|"codex"|"opencode"|"antigravity"|"cursor"|"gemini-cli"|"kimi-code"|"hermes"|Engine::(Claude|Codex|OpenCode|Antigravity|Cursor)\b' src-tauri/src | grep -v -E '_test|/test|test_|tests\.rs'
grep -rn --include='*.ts' --include='*.tsx' -E "['\"](codex|claude-code|claude|opencode|antigravity|cursor|gemini-cli|kimi-code|hermes)['\"]" src | grep -v -E '\.test\.|/tests/|__tests__|test/'
```

| Linguagem | Linhas | Arquivos | Capability ou comportamento do harness (migrar) | Registro, adaptador ou apresentação (permitido) | Contas, uso e limites | Padrão de produto, catálogo, fixture |
|---|---|---|---|---|---|---|
| Rust | 284 | 57 | 149 em 26 arquivos | 54 em 10 | 40 em 9 | 41 em 12 |
| TS/TSX | 182 | 55 | 88 em 36 arquivos | 43 em 6 | 51 em 13 | 0 |

Ressalvas: a contagem é bruta. Inclui testes inline dentro de arquivos de produção (`runs/oneshot.rs`, `runs/plan.rs`, `ipc/commands/pool.rs`) e falsos positivos de paginação (`"cursor"` em `ipc/mcp.rs:1011` e `:1044`, `runs/orchestration.rs:234`, `runs/model_discovery.rs:731`). A classificação por arquivo é por leitura do papel do arquivo, não linha a linha. O número "98" do inventário `tui-acp-frota` não é reprodutível e não deve ser citado.

### 6.2 Fonte única proposta

- **Uma só fonte:** `harness::matrix` (esta Fase 0) para o que cada provider promete, e o registro de agentes (`agents/registry.rs`) para o que ele **é** (comando, MCP, retomada, sessões). O descritor não duplica o registro: aponta para ele.
- **Quem consome:** `Engine::capabilities()` (`conversa/api.rs:74-121`) passa a ser **derivado** do descritor; `PROTOCOL_AGENTS` (`chatModel.ts:74-80`) passa a ser **lido** do backend (via `ags chat providers` e um comando Tauri), não copiado.
- **Regra de saída (Fase 3):** nenhuma comparação `agent_id == "<nome>"` decide capability fora do adapter e do registro. Um teste de lint com baseline (mesma ideia do `check:test-lint`) falha quando o número de ocorrências do grupo "migrar" cresce.
- A fonte inclui o escopo por **sessão**: o ACP local lê `agentCapabilities`; o Claude só marca `steer` quando houver captura.

### 6.3 Lista por arquivo (grupo "migrar")

**Rust** (linhas brutas): `conversa/api.rs` 31, `database/queries/session_search.rs` 13, `ipc/commands/conversas.rs` 12, `runs/roster.rs` 12, `runs/oneshot.rs` 8, `runs/plan.rs` 7, `canal/mod.rs` 6, `chat_team/permission.rs` 5, `ai_memory/tabs.rs` 5, `ipc/transport.rs` 5, `ipc/commands/canal.rs` 5, `ipc/mcp.rs` 5, `ipc/commands/peers.rs` 4, `runs/orchestration.rs` 4, `runs/supervisor.rs` 4, `session/panel.rs` 4, `runs/fixrounds.rs` 3, `runs/routing.rs` 3, `runs/mod.rs` 3, `session/title.rs` 3, `canal/timeline.rs` 2, `conversa/troca.rs` 1, `terminal/pty_manager.rs` 1, `chat_team/watch_db.rs` 1, `squads/store.rs` 1, `runs/quota.rs` 1.

**TS/TSX:** `chat/AgentModelPicker.tsx` 11, `chat/NewConversation.tsx` 7, `missions/vigia.ts` 7, `chat/structured/StructuredConversationView.tsx` 6, `chat/chatModel.ts` 5, `chat/ComposerAssistMenu.tsx` 5, `missions/modelFlags.ts` 5, `chat/ClaudeAutoCompactSetting.tsx` 3, `runs/RoutingSection.tsx` 3, e 27 arquivos com 1 ou 2 ocorrências (`chat/tasks/useConversationTasks.ts`, `chat/team/teamModel.ts`, `chat/structured/switchModel.ts`, `chat/ChatSidebar.tsx`, `chat/ConversationView.tsx`, `canvas/tabTuning.ts`, `canvas/RoleEditDialog.tsx`, `squads/*`, `terminal/Terminal.tsx`, `tabs/continuity.ts`, `palette/CommandPalette.tsx` e outros).

Os pontos que **decidem uma das 18 capabilities** (os de maior valor):

| Capability afetada | Onde |
|---|---|
| `child_stop` | `conversa/api.rs:1132` |
| `compact`, `goal` | `conversa/api.rs:809`, `:913`, `:920-921` (textos); `ComposerAssistMenu.tsx:301-304`, `StructuredConversationView.tsx:156-197` |
| `steer` | `chatModel.ts:74-85` |
| `approval` | `conversa/troca.rs:114`, `chat/structured/switchModel.ts:19-21` |
| `usage` | `chat_team/watch_db.rs:257`, `chat/summary/LimitsCard.tsx:27-33` |
| `resume` | `conversa/codex.rs:268`, `opencode.rs:194`, `tabs/continuity.ts:24` |
| `ags_mcp` | `ipc/mcp.rs:2905`, `:2922`; `agents/adapter.rs:55`, `:93` (o flag que contradiz o registro) |
| contrato duplicado | `ipc/commands/conversas.rs:78-124`, `conversa/api.rs:124-139` (`supports_access` deixa o ACP local aceitar cinco modos; a abertura só aceita `ask`, `opencode.rs:211-213`) |

### 6.4 Ordem de migração (não é desta tarefa)

1. Expor o descritor de leitura no backend (comando Tauri e `ags chat providers`), sem mudar nenhuma regra.
2. Trocar `PROTOCOL_AGENTS` por leitura do backend; manter um teste que compara as duas fontes até remover a cópia.
3. Migrar os pontos que decidem capability de **conversa** (`api.rs`, `troca.rs`, `switchModel.ts`, `ComposerAssistMenu.tsx`, `StructuredConversationView.tsx`, `teamModel.ts`, `watch_db.rs`).
4. Migrar Frota e orquestração (`supervisor.rs`, `mcp.rs`, `oneshot.rs`, `plan.rs`, `roster.rs`).
5. Contas, uso e limites, pelo registro (não pelo descritor de execução).
6. Ligar o teste de lint com baseline e baixá-lo a cada passo.
7. Trocar os `unreachable!` (`api.rs:840`, `:953`, `:989`) por erro de capability, para uma flag ligada sem implementação não derrubar o processo.

## 7. Fatia vertical da Fase 1

**Objetivo:** um turno **T** de uma conversa raiz **R** que cria **um filho de chat** e **um filho da Frota**; os dois ficam gravados, projetados e mostrados na árvore como filhos do mesmo run, sem cruzar id nem `cwd`.

### 7.1 O que a fatia grava

| Momento | Gravação | Onde |
|---|---|---|
| R cria a conversa filha C durante T (`chat_new`, ou conversa lateral) | `harness_run` do par `(R, T)` se não existir; nó `root_agent` do turno; nó `child_chat` de C com pai no root | no `insert_thread_with_context` (`conversa/store.rs`), quando `parent_turn_id` existe. **Atomicidade:** esse INSERT não abre transação (o chamador pode estar numa, como `create_inner` com recibo, ou não). A função envolve o INSERT e a ligação num `SAVEPOINT` e, se o chamador não tem transação, abre antes uma `Immediate` (como `create_run_with_memory_snapshot`). Escolha: **se a ligação falha, a conversa não é criada** e o erro sobe, em vez de criar a conversa sem o nó. Justificativa: um nó ausente não se repara depois (não há backfill) e o turno ficaria sem o filho na árvore; falhar a criação é visível e repetível pelo `client_request_id`. Sem I/O dentro do savepoint |
| R delega ao menos uma tarefa à Frota durante T (`delegate_task`, `run_plan`) | o mesmo `harness_run` (idempotente); nó `fleet_run`, pai no root; nó `fleet_task` por tarefa | na transação de `runs/orchestration.rs` (`plan_tasks`), depois de `set_run_source_thread`. O turno é o `inProgress` único da conversa, lido **dentro** dessa transação (`tx`) por `conversa::store::active_turn_id`, a mesma função que decide `parent_turn_id` do filho de chat (zero ou mais de um `inProgress` não liga nada). O retry pelo recibo volta antes dessa parte e não cria nem duplica nó. Run já existente (`add_task` ou tarefa de integrante) só ganha nó de tarefa se o run já tem nó; tarefa nunca cria run, e um run sem nó nunca é ligado depois |

O run nasce **de forma preguiçosa**, no primeiro filho. Assim a Fase 1 não mexe nos cinco adapters de conversa. Turnos sem delegação não ganham linha.

### 7.2 O que a fatia projeta e mostra

- `runs/harness.rs::thread_execution_graph` une os nós antigos (derivados) com `harness_node`. Nós com linha ganham o `id` estável; o `id` textual atual continua.
- Mudança visível: o **run da Frota passa a aparecer sob o turno que o criou**, e não sob a conversa. A conversa filha já aparece sob o turno pai (`runs/harness.rs`, `parent_turn_id`).
- Campos novos **opcionais** no grafo: `nodeId`, `harnessRunId` e `chatRunId` (só no nó de turno, com o mesmo valor de `runId`, que fica por compatibilidade até a UI migrar). Sem linha em `harness_node`, os três vêm `null`.
- No nó de turno, `activeChildren`: filhos diretos não terminais (§3.3 regra 8). Os outros nós omitem o campo. O feed mostra "N filhos ativos" só com o turno terminal e a contagem maior que zero. CLI e MCP devolvem o mesmo JSON; não há comando novo.
- O run ligado desce um nível na `depth` (e as tarefas com ele): o run sai de "filho da conversa" para "filho do turno". O pai só vale se o turno é da mesma conversa e está na árvore; senão o run fica sob a conversa, como antes.
- `HarnessRunFeed.tsx` já monta a árvore por `parentId`; a mudança é só de tipos (`src/features/runs/types.ts`).

### 7.3 Arquivos a tocar

| Arquivo | Mudança |
|---|---|
| `src-tauri/src/harness/` (novos: `identity.rs`, `store.rs`, `state.rs`) | tipos, `migrate()` (tabelas e gatilhos), `ensure_run`, `link_child_chat`, `link_fleet_run`, `link_fleet_task`, `nodes_for_threads`, mapa puro de estado (§3.2; ainda sem leitor, a projeção devolve o texto nativo), com testes |
| `src-tauri/src/conversa/store.rs` | uma chamada a `harness::store::migrate`; `active_turn_id` extraída de `active_parent_turn_id`; ligação do filho no `insert_thread_with_context`, em savepoint |
| `src-tauri/src/runs/orchestration.rs` | ligação do run e das tarefas na transação da delegação |
| `src-tauri/src/runs/harness.rs` | união com `harness_node`; campos novos |
| `src/features/runs/types.ts` | campos opcionais |
| `src/features/chat/structured/HarnessRunFeed.tsx` | com o turno terminal e `activeChildren` > 0, o texto "N filhos ativos" junto do status |
| `docs/ade-ags/HARNESS_CONTRATO.md`, `ROADMAP.md` | marcar a Fase 1 |

Nada de `database/schema.rs` nem `ipc/protocol.rs`. Os testes da Fase 1 ficam nos `test.rs` dos três módulos (`harness/test.rs`, `conversa/test.rs`, `runs/test.rs`), em submódulos `fase1`/`harness_fase1`, para o filtro `cargo test --lib harness` pegá-los.

### 7.4 Testes da fatia (prova de lógica: teste primeiro)

1. `migrate` roda duas vezes sem erro e sem perder linhas.
2. Conversa filha com turno pai ativo gera `harness_run`, root e `child_chat`; repetir a criação não duplica.
3. Delegação à Frota com turno ativo gera `fleet_run` e `fleet_task` sob o mesmo run.
4. **Mesma pasta, duas conversas:** o run da Frota da conversa B não aparece na árvore da conversa A.
5. Conversa filha sem `parent_turn_id` e run da Frota sem turno ativo **não** geram nó e continuam na projeção antiga.
6. Filho terminal (falha de tarefa, conversa filha interrompida) **não muda** o status do turno raiz na projeção.
7. Depois das duas varreduras de boot, o turno aparece `interrupted` e a tarefa que rodava aparece `interrupted`; nenhuma linha some.
8. Apagar a conversa remove só as linhas `harness_*`; `runs` e `tasks` ficam.
9. A projeção sem nenhuma linha de harness mantém ids, pais e profundidade de antes. **Não havia teste de `thread_execution_graph` no commit base**, então este teste (`a_projecao_antiga_sem_linhas_de_harness_mantem_ids_pais_e_profundidade`) fixa a forma antiga; ele não foi rodado contra o código anterior à Fase 1.
10. Visual (instância isolada, captura antes e depois): o run da Frota sob o turno. Não medido ainda.
11. Turno terminal com run da Frota `running` conta 1 (várias tarefas continuam 1); conversa filha com último turno `inProgress` conta 1; os dois contam 2; filhos terminais contam 0; filho falho não muda o status do turno. O feed mostra "N filhos ativos" com 1 e com N, e não mostra com 0 nem com o turno em andamento.

### 7.5 O que fica de fora (e não se promete)

- **Estado terminal gravado** pelo harness (Fase 3). A Fase 1 deriva do nativo.
- Gravar o run como **assentado**. `activeChildren` só existe na leitura; não há coluna nem estado novo em Zustand.
- Tentativas como nós (continuam projetadas), ferramenta, aprovação, pergunta e subagente nativo como nós.
- `node_id` nos eventos, recibos unificados, evento transacional (Fase 2).
- `ProviderSessionRef`, `ContextTransfer`, `connected_session` (Fases 3 e 4).
- **Recuperação:** nenhuma. Depois do reinício a árvore mostra o que as duas varreduras já produzem hoje (interrompido e `failed`/`cancelled`). Não há replay de evento, cursor, retomada de sessão nem relançamento.
- Leitura do descritor pela UI, IPC ou MCP; correção da lacuna de §1.7; migração dos 149 pontos por nome.
- Run da Frota fora de conversa, sessões de TUI e filhos criados com o pai ocioso.

## 8. Decisões em aberto para o usuário

Só o que é decisão de produto ou de autorização.

1. **Texto do «enviar agora» no Claude.** Enquanto o `steer` é `Unknown`, a tela promete "entra no turno em andamento". Manter a promessa, ou trocar para uma frase neutra ("vai para o Claude agora; ele a lê no meio ou logo depois do turno")? O comportamento não muda; muda a cópia nos três catálogos.
2. **Capturas reais.** Provar `Unknown` e criar fixtures `recorded` gasta conta e cota. Autoriza capturas? De quais providers (Claude, Codex, OpenCode, Antigravity, Cursor) e com que teto de turnos? Sem isso, Antigravity e Cursor ficam sem replay.
3. **Reconhecimento do fingerprint do schema.** O `schema-sqlite` está sem registro no commit base. Quem reconhece (o usuário, ou a fase que tocar o schema) e com qual motivo? Enquanto isso o passo de fingerprint do CI falha.
4. **O filho da Frota sobrevive ao turno do pai.** Decidido: continua vivo e o turno não espera. A árvore mostra "N filhos ativos" (§3.3 regra 8).

## 9. O que foi e o que não foi verificado

**Verificado**
- `cd src-tauri && cargo test --lib harness`: 14 testes do módulo novo passam. Eles conferem: 22 colunas esperadas; 18 capabilities em ordem por coluna; todo `Supported` com evidência e prova; todo `Unknown` com o que falta provar; todo `Unsupported` com motivo; **cada citação `arquivo:linha` aponta para arquivo e linhas que existem**; a tabela concorda com `Engine::capabilities()`; o doc concorda com a tabela.
- `bun run check:test-lint`.
- Leitura direta do código para D1, D2, D3, D4, D8 e D10, e para as lacunas de §1.7.

**Não verificado**
- **Existir a linha não prova que ela diz o que a célula afirma.** O teste confere arquivo e intervalo. Uma auditoria linha a linha de todas as citações suspeitas e veredictos da matriz foi realizada (§9.1), corrigindo citações quebradas, afirmações não sustentadas e reclassificações comprovadas no código.
- Nenhum provider real foi executado. Nenhuma célula tem captura real.
- O T3 (`main` móvel) não foi relido: §2.6 repete o que o inventário `antigravity-t3.md` cita.
- Sem medição de desempenho: o custo de `thread_execution_graph` (que carrega todas as conversas, `runs/harness.rs:100`) e de árvores profundas está **não medido**.
- A suíte completa e o `cargo test --lib --bin ags` não foram rodados. `bun run check:fingerprint` continua falhando, como no commit base.
- Nenhum teste visual, build, instalação, push ou PR.

### 9.1 Auditoria e correções de evidências da matriz

Auditoria completa das citações e afirmações da matriz de capabilities e do contrato (`auditoria-citacoes.md` e TSVs de veredictos), confirmando cada item diretamente no código:

1. **Citações quebradas e afirmações não sustentadas corrigidas**:
   - `claude/start`: rebaixado `Proof::Test` para `Proof::Code` citando `claude.rs:188-193` (o teste anteriormente citado não invocava `open`).
   - `claude/interrupt`: substituído teste de outro motor por `test_bancada.rs:101-105`.
   - `claude/tool_events`: adicionada citação da fixture `claude-normal-ok`.
   - `claude/approval`: adicionada citação do código real de resolução (`claude.rs:600-611`, `api.rs:1143-1167`).
   - `claude/child_spawn`: citação de teste corrigida para `tarefas_test.rs:33-44`.
   - `claude/child_result`: nota corrigida (o texto de `Out::SubItem` é lido pelo adapter e exibido na janela via `taskItem`, mas não é gravado no banco; citação `claude_map.rs:202-215`).
   - `codex/start`: rebaixado `Proof::Test` para `Proof::Code` citando `codex.rs:283-288`.
   - `codex/interrupt`: citação de interrupção ajustada para `api.rs:1104-1108` (`turn/interrupt`); a lógica do Parar pendente está em `codex.rs::Session::stop` e `codex_parar.rs`.
   - `codex/tool_events`: adicionada fixture `codex-normal-ok`.
   - `codex/question`: rebaixado `Proof::Test` para `Proof::Code` citando `codex.rs:478-482`.
   - `codex/approval`: citação de teste removida (apontava para Claude), citando `codex.rs:517-524`, fixture `codex-normal-ok` e `api.rs:1172`.
   - `codex/resume`: rebaixado `Proof::Test` para `Proof::Code` citando `codex.rs:283-288` (removida citação indevida de `test_bancada.rs:272`).
   - `codex/event_source`: rebaixado `Proof::Test` para `Proof::Code` citando o mapeamento JSON-RPC em `codex.rs:426-436`, `:364-371`, `:403-422`, `:469-501`.
   - `opencode/steer`: adicionada citação de enfileiramento em `queueRunner.ts:48-58`.
   - `opencode/goal`: removida citação falsa de `conversas.rs:113` (mantendo `bancada.rs:159`).
   - `opencode/ags_mcp`: citação corrigida para `opencode.rs:474-489` (injeção de `mcp_servers`).
   - `antigravity/usage`: adicionada citação de teste `test_motores.rs:347-377`.
   - `cursor/interrupt`: esclarecido na nota que a fixture prova fim de turno por SIGKILL/queda de processo (`cursor.rs:217-223`), e não parada cooperativa pelo ADE.
   - `cursor/child_result`: citação corrigida para `cursor_map.rs:129-140`.
   - `antigravity/resume`: `Proof::Test` com `agy.rs:224-248`, `agy_map.rs:376-389`, `resume.rs:176-199` e os testes `test.rs:779-901` e `test_motores.rs:465-489` (guarda de retomada por turno, §11.12). Não passa por `open_resuming`.
   - `cursor/resume`: `Proof::Test` com `cursor.rs:243-267`, `cursor_map.rs:390-392`, `resume.rs:176-199` e os testes `test.rs:779-901` e `test_motores.rs:907-920` (guarda de retomada por turno, §11.12). Não passa por `open_resuming`.
   - `local-acp/steer`: adicionada citação de `queueRunner.ts:48-58`.

2. **Ajustes e tensões na Frota**:
   - `codex/turn_completion`: citação corrigida de `:490-492` para `src-tauri/src/runs/adapters.rs:496-498`.
   - 6 células de `resume` da Frota (`claude-code`, `gemini-cli`, `codex`, `opencode`, `kimi-code`, `antigravity`): mantido estado `Unsupported`, adicionada documentação da tensão com `run_hand_off_task` (`runs/mod.rs:1116-1157`), que reabre sessão nativa com `--resume` em nova aba interativa, mas não retoma a tarefa automaticamente no boot do app.

3. **Reclassificações de estado**:
   - `tui/claude-code` e `tui/codex`: `child_spawn`, `child_result`, `child_stop` rebaixados de `Unknown` para `Unsupported` com base em `canal/claude.rs:83-84` e `canal/codex.rs:83-84` (`nao_suporta("subagentes")`).
   - `tui/hermes`: `question` rebaixado de `Supported` para `Unknown`, com `missing` registrando a necessidade de confirmação da ferramenta `ask_user` visível em sessão real do Hermes (`ags_mcp` do Hermes permanece `Unknown`).
   - `tui/claude-code`: `question` mantido `Supported`, citando MCP `ask_user` e `canal/claude.rs:83-84`.
   - `tui/gemini-cli` e `tui/codex`: `resume` com citações de descoberta de sessão (`session/title.rs:1400-1410`, `:1526-1540`).
   - `tui/cursor`: `resume` corrigido para `registry.rs:398`.

4. **Contrato e documentação**:
   - §1.2 e §1.3: tabelas e contagens atualizadas (163 `Supported`, 29 `Unknown`, 204 `Unsupported`).
   - §1.5: documentada a tensão entre retomada automática de tarefa na Frota e hand-off manual.
   - §1.7: citação de `close_orphan_runs` corrigida para `conversa/store.rs:1068-1082`.
   - §3.2: citação do Codex corrigida para `codex.rs:573-574` e frase de `SWEPT_RUNNING_ERROR` corrigida para esclarecer que `end_reason` não existe na projeção atual.
   - §5.2, §5.3 e §5.5: B2, B3, B4 e B5 documentados como resolvidos pela bancada ampliada (`other_aceito` em `bancada.rs:1086-1092`, preservação de filhos em `bancada.rs:795-796`, etc.), restando apenas `uso` no snapshot.


**Defeito do commit base encontrado e corrigido à parte:** `cargo test --lib` não compilava (três chamadas de `switch_team_member` em `conversa/troca_test.rs` com a assinatura antiga). O ajuste (`None, None`) está num commit separado e não muda comportamento de produção.

## 10. Fase 1: o que foi e o que não foi verificado

**Verificado** (`cargo test --lib harness`: 37 testes, 23 novos da Fase 1; a suíte completa e as demais verificações estão no relatório da tarefa)
- Testes 1 a 9 de §7.4, mais: atomicidade (falha da ligação não cria a conversa, na transação própria e na do chamador; desfazer a transação do chamador desfaz conversa e nó), retry pelo recibo sem nó novo, nó órfão (apagar conversa lateral filha, a tarefa ou o run da Frota, e o CASCADE do workspace).
- Mutação feita à mão: sem a ligação do run da Frota e sem o `ROLLBACK TO`, sete testes falham.
- `bunx tsc --noEmit` e `bun run check:test-lint` (sem violação nova). `bun run check:fingerprint` continua falhando só por `schema-sqlite` (sha `96507e01a45b…`, o mesmo do commit base): `database/schema.rs` não foi tocado.

**Não verificado**
- Teste 10 (visual): nenhuma captura, sem build nem instância isolada. `HarnessRunFeed.tsx` não foi alterado e não se sabe se o run sob o turno aparece como esperado.
- Que o turno é lido *dentro* da transação é garantido pela construção (a chamada usa `tx`), não por um teste de concorrência.
- Desempenho: `thread_execution_graph` ganhou uma consulta a `harness_node` por lote de 400 conversas; **não medido**.
- Com o harness quebrado (tabela ausente, por exemplo), criar conversa filha e delegar à Frota passam a falhar: é a escolha de §7.1, sem teste de migração parcial.

## 11. Fase 2: recibos de comando e fila de efeitos (desenho e primeira fatia)

**Objetivo da fase:** um comando que muda o mundo (enviar, interromper, criar filho, responder pedido, cancelar) ganha um recibo idempotente e, quando executa um efeito fora do banco, uma linha de efeito com dono e prazo. A repetição do mesmo comando devolve o recibo; nunca reinicia processo nem reenvia mensagem.

Entregue nesta fatia: o módulo de recibos (`harness/receipts.rs`), a fila de efeitos (`harness/effects.rs`), o recibo do **envio de mensagem do chat estruturado** ponta a ponta (`conversa/send_receipt.rs`) e a leitura unificada dos dois recibos antigos. O resto da fase fica na ordem de §11.8.

### 11.1 Tabelas (aditivas, no `migrate()` do módulo)

Criadas por `harness::store::migrate`, que chama `receipts::migrate` e `effects::migrate`. `database/schema.rs` não muda; as tabelas ficam fora do alvo do fingerprint (§4.1). Sem `CHECK` de enumeração e sem FK: o recibo preserva a identidade do pedido mesmo se a pessoa apagar a conversa ou o run (mesma escolha de `run_delegation_receipts`).

```sql
CREATE TABLE IF NOT EXISTS harness_command_receipt (
    kind           TEXT NOT NULL,      -- chat_send | chat_interrupt | chat_new | fleet_delegate | request_answer | task_cancel
    caller_key     TEXT NOT NULL,      -- quem chamou (escopo do chamador, nunca o texto do pedido)
    request_id     TEXT NOT NULL,      -- client_request_id
    request_hash   TEXT NOT NULL,      -- sha256 do payload canônico (sem o próprio id)
    target_ref     TEXT NOT NULL,      -- o alvo: thread_id, run_id…
    node_id        TEXT,               -- harness_node, quando o comando já tem nó (Fase 3+)
    state          TEXT NOT NULL,      -- prepared | submitting | accepted | retryable | unknown
    result_json    TEXT,               -- resultado pequeno da aceitação (ids; nunca texto de agente)
    event_sequence INTEGER,            -- cursor do evento (harness_execution_events.id); NULL até o comando migrar o evento
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    PRIMARY KEY (kind, caller_key, request_id)
);

CREATE TABLE IF NOT EXISTS harness_effect (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    kind               TEXT NOT NULL,          -- chat_send, … (validado em Rust)
    dedupe_key         TEXT NOT NULL UNIQUE,   -- um efeito por intenção: enfileirar duas vezes devolve o mesmo
    target_ref         TEXT NOT NULL,
    state              TEXT NOT NULL,          -- pending | running | completed | failed | cancelled
    retry_safe         INTEGER NOT NULL,       -- 1 se repetir o efeito é inofensivo (filesystem idempotente); 0 para provider
    attempts           INTEGER NOT NULL DEFAULT 0,
    max_attempts       INTEGER NOT NULL,
    lease_owner        TEXT,
    lease_until        INTEGER,                -- ms; só vale em `running`
    causation_event_id INTEGER,                -- o evento que causou o efeito (NULL até o comando migrar o evento)
    receipt_kind       TEXT, receipt_caller TEXT, receipt_request TEXT,   -- o recibo que o efeito serve
    outcome_unknown    INTEGER NOT NULL DEFAULT 0,
    last_error         TEXT,                   -- sanitizado (§11.4)
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_harness_effect_ready ON harness_effect(state, lease_until);
```

O efeito **não guarda o payload**. O texto de uma mensagem, o prompt e qualquer segredo ficam só na memória de quem chamou (`AGENTS.md` §2.3). Por isso o worker nunca "reenvia sozinho" um `chat_send`: depois de uma queda só a repetição do comando, com o mesmo `client_request_id` e o texto de volta, reclama o efeito de novo (§11.6).

### 11.2 Estados

**Recibo** (mesmo vocabulário de `chat_child_receipts.delivery_state`):

| Estado | Significa | Quem sai dele |
|---|---|---|
| `prepared` | a intenção está gravada; nada foi tentado | `claim` → `submitting` |
| `submitting` | um chamador reclamou o efeito e está falando com o provider | `accepted`, `retryable` ou `unknown` |
| `accepted` | o provider aceitou | terminal |
| `retryable` | **nada chegou** ao provider (falha antes de sair) | `claim` → `submitting` com o mesmo `client_request_id` |
| `unknown` | o pedido pode ter chegado | terminal: nunca repetir às cegas |

**Efeito:**

| Estado | Significa | Transições |
|---|---|---|
| `pending` | enfileirado, sem dono | `claim` → `running`; `cancel` → `cancelled` |
| `running` | tem dono e `lease_until` | `complete` → `completed`; `fail` → `pending` (nada saiu e ainda há tentativa), `failed` (definitivo ou desfecho desconhecido); `cancel` → `cancelled`; lease vencido → ver §11.3 |
| `completed` | o efeito foi aplicado | terminal |
| `failed` | falhou de vez, ou `outcome_unknown = 1` | terminal |
| `cancelled` | cancelado antes de concluir | terminal; um `complete` tardio do dono antigo é recusado |

`fail` recebe uma **disposição**: `NotApplied` (o efeito certamente não saiu: volta a `pending` até `max_attempts`), `Permanent` (`failed`) ou `Unknown` (`failed` com `outcome_unknown = 1`).

### 11.3 Lease e claim

- `claim(id | próximo, dono, agora, lease_ms)` roda numa transação `Immediate` e faz **um** `UPDATE … WHERE state = 'pending'` (ou `running` com lease vencido); só quem vê `changes() == 1` é o dono. Duas conexões no mesmo arquivo nunca chegam as duas a `Claimed`.
- O `agora` é um **parâmetro** (`util::now_ts_ms()` só na borda). Nenhum teste espera relógio.
- `complete`, `fail` e `extend_lease` exigem `lease_owner = dono` e `state = 'running'`: o dono antigo, de lease vencido e já reclamado, não consegue concluir por cima.
- **Lease vencido** (`running` com `lease_until <= agora`): o dono pode ter morrido antes **ou depois** de o efeito sair. O `claim` não decide sozinho:
  - `retry_safe = 1` → reclama e conta a tentativa;
  - `retry_safe = 0` → não reclama. O efeito vai a `failed` com `outcome_unknown = 1` e o recibo a `unknown`, **a menos que** `recover_expired` receba a capability do adapter que prova o desfecho (`Applied` → `completed`, `NotApplied` → `pending`, `Unknown` → `failed` + `outcome_unknown`).
- `recover_expired` (boot ou worker) só pergunta ao adapter pelos efeitos `retry_safe = 0`; um `retry_safe = 1` de lease vencido volta a `pending` sem prova (ou a `failed`, se as tentativas acabaram).
- `max_attempts` limita as reclamações: ao estourar, `failed`.
- **Erro sanitizado** (`last_error`): só código curto e mensagem do próprio ADE. Passa por `sanitize_error`: uma linha, até 200 caracteres, sem controles, com tokens de aparência de segredo (`sk-…`, `ghp_…`, `Bearer …`, `chave=valor` de token/senha, sequências longas de base64/hex) trocados por `[redigido]`. O chamador **não** passa mensagem de provider nem texto do agente: o `chat_send` grava só `not_sent` ou `outcome_unknown`.

### 11.4 Fronteiras de transação

| Passo | Dentro do lock e da transação | Fora |
|---|---|---|
| 1. aceitar | `Immediate`: `begin` do recibo (confere hash), `enqueue` do efeito, e, quando o comando migrar, evento e projeção | — |
| 2. reclamar | `Immediate`: `claim` do efeito e recibo `prepared/retryable` → `submitting` | — |
| 3. executar | — | provider, filesystem, processo: **sem** lock do banco (`BACKEND.md`) |
| 4. concluir | `Immediate`: `complete`/`fail` do efeito e o recibo → `accepted`/`retryable`/`unknown` | publicar na UI só **depois** deste commit |

A tela e o `bus` nunca recebem "concluído" antes do passo 4. Hoje `queue_chat_event`/`queue_fleet_event` (`runs/execution_log.rs`) ainda fazem o contrário; a ordem de migração está em §11.8.

### 11.5 O que acontece em cada ponto de crash (`chat_send`)

| Ponto | Estado deixado | Recuperação |
|---|---|---|
| antes do passo 1 | nada | o comando nunca existiu; repetir é um comando novo |
| entre 1 e 2 | recibo `prepared`, efeito `pending` | a repetição com o mesmo id reclama e executa (o efeito sai uma vez) |
| entre 2 e 3 | recibo `submitting`, efeito `running` com lease | o desfecho é indecidível (o efeito pode ter saído): ao vencer o lease, `unknown`. Sem repetição cega |
| entre 3 e 4 | idem | idem: sem capability de reconciliação do envio (a matriz marca `send` como "não é ack do agente", §1.1), vira `unknown` |
| depois de 4 | recibo `accepted` | a repetição devolve o recibo, `replayed = true`, sem enviar |
| falha de envio com `NotSent` | recibo `retryable`, efeito `pending` | a repetição reenvia (é seguro: nada saiu) |
| falha com `Unknown` | recibo `unknown`, efeito `failed` + `outcome_unknown` | a repetição devolve o recibo com o aviso "confira a conversa" |

Lease do chat_send: 120 s, mais que o prazo de um `turn/start` do Codex. Um reenvio durante um lease ainda vivo devolve `submitting` (sem enviar).

### 11.6 Recibos antigos (unificação)

`receipts::lookup`/`begin` leem `harness_command_receipt` e **caem nas duas tabelas antigas** (`chat_child_receipts` para `chat_new`, `run_delegation_receipts` para `fleet_delegate`), devolvendo o recibo no formato novo. A escrita de `fleet_delegate` é **dupla** (`runs::store::save_delegation_receipt` grava as duas) até a nova tabela ser provada em uso; `chat_new` continua só na antiga. Nada é apagado, e a antiga continua a fonte quando as duas divergem. O mesmo `client_request_id` com payload diferente falha fechado em qualquer das fontes.

### 11.7 Comando de ponta a ponta: envio do chat estruturado

- `chat_thread_send` (Tauri), `chat.send` (CLI `ags chat send --client-request-id …`) e `chat_send` (MCP) aceitam `client_request_id` (ou `clientRequestId`), até 128 caracteres, sem controles.
- Chave: `kind = chat_send`, `caller_key = chat-send:<hash do escopo do chamador>` (aba/conversa do MCP; `ui` e `cli` nos outros casos), `request_id`. O hash do payload cobre conversa, texto e imagens.
- **Sem o id, o caminho é o de antes**, sem recibo e sem efeito.
- Com o id: `accepted` devolve o recibo sem enviar; `submitting` e `unknown` devolvem o recibo com aviso e **não** enviam; `prepared` e `retryable` reclamam o efeito e enviam uma vez.
- Resposta: `{ requestId, deliveryState, replayed, sent, note? }`; `sent` só é `true` quando **esta** chamada enviou. O comando Tauri devolve `null` sem o id (como antes) e o recibo com ele; a CLI e o MCP devolvem `{ sent, receipt, next }`.
- O escopo do MCP (`caller_scope`) é carimbado por `scoped_chat_payload` (`tab:<id>`, `cwd:<pasta>` ou `task:<id>`); um valor mandado pelo modelo é descartado.
- Um erro `NotSent`/`Unknown` do provider volta como erro, como sempre, e o recibo fica `retryable`/`unknown`. A mensagem do provider **não** é gravada (só `not_sent` e `outcome_unknown`).

### 11.8 Ordem de migração dos comandos

| # | Comando | Estado | O que falta |
|---|---|---|---|
| 1 | `chat_send` | **entregue** (esta fatia) | evento e `causation_event_id` |
| 2 | `fleet_delegate` | leitura unificada e escrita dupla; **a leitura de `orchestration.rs` passa por `receipts::lookup` desde a Fase 4 (§12.5)** | `begin` no lugar do `INSERT` da delegação |
| 3 | `chat_new` | leitura unificada (esta fatia) | mover `claim_child_delivery` para `receipts`/`effects` |
| 4 | `chat_interrupt` (`api::stop`) | próxima fatia | efeito `chat_interrupt`; a capability `interrupt` já existe na matriz |
| 5 | `request_answer` (`answer.rs`) | próxima fatia | o recibo guarda o `request_id` do pedido; responder duas vezes não reenvia ao provider |
| 6 | `task_cancel` (Frota) | próxima fatia | subárvore cancelada uma vez; efeito de filesystem `retry_safe` |
| 7 | `queue_chat_event`/`queue_fleet_event` | depois dos comandos | gravar o evento na transação do passo 1; trocar o `stderr` por um sinal recuperável; só então a UI publica depois do commit |
| 8 | worker contínuo | Fase 5, se a prova pedir | `claim_next` em laço, `recover_expired` no boot |

### 11.9 O que a fatia não faz

- Não há worker em segundo plano: quem aceita o comando também reclama e executa o efeito (o claim com lease já impede dois donos). `recover_expired` existe e é testado, mas **ainda não é chamado no boot**.
- Nenhum recibo guarda `event_sequence` nem efeito guarda `causation_event_id` ainda: as colunas existem (aditivas) e ficam `NULL` até `queue_chat_event` migrar.
- Interrupt, spawn, resposta a pedido e cancelamento não usam a fila.
- Nenhum provider real foi executado.

### 11.10 Fase 2, primeira fatia: o que foi e o que não foi verificado

**Verificado**
- Testes escritos antes: 32 testes de `harness::test_fase2` contra esqueletos `unimplemented!()` (31 falharam, 1 passou por não depender do código). Depois da implementação, os 32 passam.
- 13 testes de `conversa::send_receipt_test` (reenvio idêntico não reenvia; payload diferente falha fechado; `NotSent` → `retryable` e a repetição envia uma vez; `Unknown` nunca repete; queda entre aceitar e reclamar é recuperável; lease vivo devolve `submitting`; lease vencido vira `unknown`; o dono lento ainda conclui; a mensagem do provider não vai ao banco) e 4 de contrato do MCP e da CLI em `ipc/test.rs`.
- Claim concorrente: duas conexões em threads no mesmo arquivo SQLite temporário (WAL), 40 efeitos disputados por `claim` e 30 por `claim_next`; cada efeito teve exatamente um dono. O `agora` é sempre injetado.
- `cd src-tauri && cargo test --lib --bin ags`: 2685 + 52 testes, 0 falhas, 29 ignorados (os de sempre). Sem warning novo.
- `node scripts/fingerprint.mjs`: ok (`schema-sqlite 96507e01a45b`, `protocolo-ipc 1959c50fc9d7`; nenhum reconhecimento foi necessário, o protocolo IPC não mudou).
- `bunx tsc --noEmit` e `bun run check:test-lint` (sem violação nova).

**Não verificado**
- Nenhum provider real foi executado: o `execute` dos testes é um contador. O caminho `send_with_request` com `AppHandle` não tem teste de ponta a ponta.
- O recibo e o efeito rodam em transações separadas (aceitar, reclamar, concluir); a atomicidade de cada passo é por construção e por teste de estado, não por injeção de falha no meio do commit.
- Desempenho: `harness_effect` não tem consulta medida; o índice `(state, lease_until)` não foi exercitado com volume.
- Ainda não existe comando de boot que chame `recover_expired`: um efeito `running` de provider só vira `unknown` quando a repetição do comando chega ao `claim` (§11.9).
- Teste visual e a UI: `chatThreadSendOnce` existe em `ipc.ts`, mas nenhuma tela o chama ainda.

### 11.12 Retomada por turno do Cursor e do Antigravity: não repetir às cegas

O Cursor (`--resume <id>`) e o Antigravity (`--conversation <id>`) sobem **um processo por turno**, e o prompt sai junto com o id. Por isso **não** usam `resume::open_resuming`, que abre a sessão antes de qualquer mensagem sair e pode repeti-la: aqui, repetir é rodar o prompt de novo depois de o agente ter editado arquivos ou rodado comandos. A tentativa que envolveu o turno inteiro em `open_resuming` foi rejeitada por isso (retentativa em erro transitório, e um `not found` genérico, de uma ferramenta, virando "sessão perdida").

`resume::run_turn_resuming` (`resume.rs:176-199`) só repete o turno quando **as três** condições valem:
1. havia id remoto e o turno acabou em erro;
2. **nenhuma linha de stdout chegou** (`began == false`): nem `init`/`system` com o id da sessão, nem item, nem texto, nem linha ilegível;
3. o classificador **do motor** reconhece, no stderr, a frase de sessão ou conversa inexistente.

Então, e só então: limpa o id remoto (`session.conversation` e `chat_thread.remote_id`), grava o aviso `resumeLost` (`lost_notice`) e roda o turno **uma vez** sem retomada. Se o turno novo também falhar, o erro é devolvido, sem terceira tentativa. Qualquer outro desfecho é o de antes: o turno falha (ou termina) e o id é mantido. Em particular: sem retentativa em erro transitório, sem repetição depois de qualquer evento do turno, sem repetição quando o stderr é um `file not found` ou `model not found` de outra coisa, e sem repetição de turno parado ou concluído.

| Motor | Classificador | Critério (conservador) |
|---|---|---|
| Cursor | `cursor_map::session_refused` (`cursor_map.rs:390-392`) | alguma linha do stderr tem «chat», «session» ou «conversation» **colado** a um marcador de inexistência (`not found`, `no … found`, `no such …`, `does not exist`, `invalid …`, `unknown …`, `could not find …`, `expired`); `_` vale como espaço |
| Antigravity | `agy_map::session_refused` (`agy_map.rs:376-389`) | o mesmo, com «conversation» ou «session», **ou** um `AGY_ERROR: {...}` (o formato que `error_from_stderr` já lê) com `status = NOT_FOUND` e «conversation»/«session» na mensagem |

**Evidência da frase: não há captura.** Nenhuma fixture (`cursor-*`, `antigravity-*`) recusa a sessão: `cursor-queda` e `antigravity-queda` são kill sem stderr. O único «Session not found» do repositório é o do Hermes (`agents/registry.rs:358`) e o «No conversation found» é o do Claude (`claude.rs:226`); nenhum dos dois prova o que o `cursor-agent` ou o `agy` escrevem. As frases acima são hipóteses, e o critério as exige **coladas ao nome da sessão**, mais o stdout vazio: um falso positivo é improvável, e um falso negativo só devolve o comportamento de antes (o turno falha, o id fica). O `NOT_FOUND` do `AGY_ERROR` vem do vocabulário gRPC que o próprio `AGY_ERROR` já usa (`RESOURCE_EXHAUSTED`, `test_motores.rs:459`), também sem captura da conversa inexistente.

**Lacuna conhecida:** se o CLI recusar a sessão por um frame de stdout (um `result` com `is_error`, por exemplo) em vez de stderr, o turno conta como iniciado e não é repetido. É o lado seguro; só uma captura real decide se vale cobrir.

**Provado** (`cargo test --lib conversa`): `test.rs:779-901` (o guarda, com closures e sem processo nem relógio: recusa antes de qualquer evento → turno novo e aviso, na ordem `run:<id>`, `forget`, `notice`, `run:-`; falha depois de eventos → nenhuma repetição e id mantido; `file not found` de ferramenta → nenhuma repetição; retomada que funciona → nenhuma sessão nova e nenhum aviso; turno novo que falha → não repete; sem id remoto; erro sem explicação; turno concluído) e `test_motores.rs:465-489` e `:907-920` (os classificadores, com frases positivas e negativas).

**Não verificado:** nenhum CLI real foi executado. A ligação em `cursor.rs`/`agy.rs` (contagem das linhas do stdout, captura do stderr, limpeza do banco e gravação do aviso) não tem teste de ponta a ponta; só o guarda e os classificadores têm. O aviso não foi visto na tela.

## 12. Fase 4: delegação única (`delegate_agent` com três destinos)

**Objetivo:** o orquestrador escolhe **onde** o trabalho vai, de forma explícita, e a mesma pergunta repetida nunca vira prompt duplicado em nenhum dos três caminhos. Núcleo de backend; a entrega durável do resultado ao pai e a UI ficam fora (§12.8).

Código: `harness/delegate.rs` (decisão, recibo e classificação, provados sem o app), `ipc/commands/delegate.rs` (cola com o app: comando IPC `team.delegate`, na CLI `ags team delegate`), `ipc/commands/team.rs` (descoberta e leitura das sessões), `ipc/mcp.rs` (esquema e roteamento), `runs/orchestration.rs` (leitura do recibo da Frota). Testes: `harness/test_fase4.rs`, `ipc/test.rs` e `runs/test.rs`.

### 12.1 Esquema de `delegate_agent`

Campos comuns: `task` (obrigatório), `client_request_id` (obrigatório, até 128 caracteres, sem controles), `context` (até 16 KiB, vai como dado não confiável), `mode` (`async` padrão | `wait`), `timeout_s` (10 a 1800, padrão 300).

`target` escolhe o destino: `provider_chat` | `fleet_task` | `connected_session`. **Compatibilidade:** sem `target`, `execution` (`chat` | `fleet`) vale como apelido (`chat` = `provider_chat`, `fleet` = `fleet_task`) e a chamada envia exatamente o que enviava. Os dois juntos têm de concordar (`target_conflict`). `required` do esquema agora é `task` e `client_request_id`; sem `target` nem `execution`, o erro de antes (`execution precisa ser 'chat' ou 'fleet'`) volta com a menção ao `target`.

| Destino | O que faz | Campos próprios | Recibo |
|---|---|---|---|
| `provider_chat` | abre uma conversa nova de um provider nativo (`chat.new`, filha da chamadora) | `agent`, `model`, `effort`, `title` | `chat_new` (`chat_child_receipts`), resultado = id da conversa |
| `fleet_task` | cria uma tarefa headless da Frota (`run.delegateTask`) | `agent`, `model`, `complexity`, `account_id`, `isolate`, `budget_usd`, `result_schema`, `write_scopes`, `role`, `title` | `fleet_delegate` (`harness_command_receipt` + `run_delegation_receipts`), resultado = id do run e as chaves das tarefas |
| `connected_session` | entrega o trabalho a uma sessão **já aberta e ligada ao time** (`team.delegate`, que usa `peer tell`, ou `peer ask` em `mode=wait`; na CLI, `ags team delegate <nome> --task … --client-request-id <id>`) | `to` (id ou nome de `team_candidates`), `constraints`, `expecting`, `policy` (`read` \| `ask`, padrão `ask`), `when_busy` (`fail` padrão \| `queue`) | `connected_session` (`harness_command_receipt`), resultado = id da mensagem |

Os campos de outro destino são ignorados, não repassados. `connected_session` não cria PTY, worktree nem orçamento de Frota.

### 12.2 Descoberta (`team_candidates`)

Cada candidato traz, além do que já trazia: `cwd`, `available` e `availability` (`available` | `busy` | `disconnected`), `canReceiveWork` (o `delegate_agent` aceitaria agora, com `when_busy=queue`), `blocker` (o primeiro código de recusa, ou `null`), `policy` real (nunca escondida) e `requiresPersonApproval`. A lista **não amplia** o que o agente enxerga: continuam entrando só os integrantes e as sessões da mesma pasta. `requiresPersonApproval` é `true` para quem não é integrante e é de outra pasta (hoje nunca aparece na lista; vale se a regra de visibilidade mudar). A lista não cria acesso: o envio revalida.

### 12.3 Validações no instante do envio (`connected_session`)

Tudo é lido de novo no envio (`team::delegation_snapshot`), nunca de uma listagem antiga, e **antes** de qualquer escrita. A primeira falha vence, e nada é gravado na sessão nem no recibo.

| Ordem | Checagem | Código |
|---|---|---|
| 0 | quem chama é o orquestrador do time e a conversa dele está aberta | `not_orchestrator`, `caller_not_open` |
| 1 | a sessão existe entre as abertas (mesma pasta ou do time) e os integrantes; nome repetido recusa | `session_not_found`, `session_ambiguous` |
| 2 | não é a própria chamadora nem um terminal comum (`bash`) | `session_incompatible` |
| 3 | está conectada: aba com processo, conversa ativa ou portal. Integrante cuja aba fechou também cai aqui | `session_disconnected` |
| 4 | está no time; sem vínculo, a mesma pasta pede `team_link` e outra pasta é da pessoa. **O envio nunca liga sozinho** | `session_not_linked`, `session_other_workspace` |
| 5 | a política do integrante não passa do teto (`ask` por padrão). Pedir `edits` ou `full` como teto é recusado. **Nunca converte vínculo em Acesso total** nem o eleva | `policy_elevated`, `policy_not_allowed` |
| 6 | não está no meio de um turno, salvo `when_busy=queue` (a mensagem entra na fila da sessão) | `session_busy` |

A mesma checagem alimenta `blocker` na descoberta. A ocupação lida é um instante: a fila do `peer` ainda recusa o que quebrou entre a leitura e a escrita (então `not_sent`). Uma aba que o registro de PTYs do backend não conhece é perguntada à janela, só para a sessão escolhida.

### 12.4 Recibo e idempotência

Chave: `(kind, caller_key, request_id)`. Para `connected_session`, `kind = connected_session` e `caller_key = tab:<aba da chamada>`, carimbada pelo MCP a partir da sessão e nunca do modelo. O hash cobre destino, `to`, `task`, `constraints`, `expecting`, `context`, `mode`, `policy` e `when_busy`; **não** cobre o `client_request_id` nem o prazo. O `result_json` guarda só ids (`messageId`, `queued`), nunca texto de agente.

| Situação na repetição | Resultado |
|---|---|
| recibo `accepted`, mesmo hash | devolve o mesmo resultado (`replayed: true`, `sent: false`, mesmo `messageId`). **Não revalida e não envia** |
| mesmo id, outro hash | `request_conflict` (o texto de `receipts::MISMATCH`), sem revalidar nem enviar |
| `submitting` dentro de 120 s | devolve `deliveryState: submitting`, sem enviar |
| `submitting` vencido (> 120 s) | vira `unknown` e devolve, sem enviar: o dono pode ter enviado antes de morrer |
| `unknown` | devolve com o aviso "confira a conversa ou a aba"; nunca repete às cegas |
| `retryable` (nada chegou) | **só** uma chamada explícita com o mesmo id tenta de novo, uma vez; não há retry silencioso |
| a validação do §12.3 falhou | nenhum recibo; depois de corrigir o estado, a mesma chave é um pedido novo |

O `peer` recebe `id = delegate:<client_request_id>`, de modo que a fila dele também não digita duas vezes. Respostas do `peer tell`/`ask` viram: `sent` (entregue ou na fila) → `accepted`; recusa, cancelamento, escalada ou duplicata não repetida → `not_sent`; texto escrito sem confirmação, erro depois do enfileiramento ou resposta ilegível → `outcome_unknown`. A fala do agente em `mode=wait` volta como `untrustedReply` e nunca entra no recibo; na repetição ela não existe mais (leia a conversa). O lock do banco nunca fica preso durante a revalidação nem o envio.

### 12.5 Os três caminhos num só recibo

`delegate::lookup_replay(conn, target, caller_key, request_id, hash)` lê o recibo de qualquer destino pelo `harness::receipts::lookup` (tabela nova e, na falta dela, a antiga) e devolve o id da conversa (`provider_chat`), do run (`fleet_task`) ou da sessão (`connected_session`; a mensagem fica no `result_json`). Mesmo id com outro hash é `request_conflict`.

- `fleet_task`: `runs/orchestration.rs` deixou de ler `run_delegation_receipts` direto e lê pelo `receipts::lookup`. A escrita continua dupla (`save_delegation_receipt`): nada duplicado, e a antiga segue como fonte onde só ela existe.
- `provider_chat`: o recibo continua o de `chat_child_receipts` (estados `prepared`..`unknown`), lido pelo mesmo caminho. Não migrei a escrita.
- `connected_session`: só a tabela nova.

### 12.6 Erros

Os erros de delegação voltam como texto `"<código>: <mensagem>"` (`isError` no MCP). Códigos: `invalid_target`, `target_conflict`, `invalid_request`, `not_orchestrator`, `caller_not_open`, `snapshot_failed`, `session_not_found`, `session_ambiguous`, `session_disconnected`, `session_busy`, `session_incompatible`, `session_not_linked`, `session_other_workspace`, `policy_elevated`, `policy_not_allowed`, `request_conflict`, `not_sent`, `outcome_unknown`, `receipt_failed`. Em `not_sent`, `outcome_unknown` e `receipt_failed` o recibo já foi tocado; nos demais, nada foi escrito.

### 12.7 O que foi e o que não foi verificado

**Verificado**
- Testes escritos antes: 43 testes de `harness::test_fase4` contra um esqueleto `todo!()` (todos falharam) e o teste de leitura unificada da Frota (falhou: sem a linha da tabela antiga a repetição criava outro run). Depois da implementação passam, mais 6 de contrato do MCP em `ipc/test.rs`.
- Em cada destino: repetição idempotente (a mesma conversa, o mesmo run, a mesma mensagem), outro conteúdo falha fechado. Sessão ocupada, de outra pasta, desconectada, não ligada, com política elevada ou incompatível falha **sem** chamar o envio e sem recibo.
- Chamada antiga sem `target` envia o mesmo payload que `target` novo (`chat.new` e `run.delegateTask`).

**Não verificado / fora**
- Nenhum agente real foi acionado: o envio dos testes é um contador. A cola `ipc/commands/delegate.rs` e `team::delegation_snapshot` (que dependem do `AppHandle`, do registro de PTYs e da janela) **não têm teste de ponta a ponta**.
- A mesma `client_request_id` usada em destinos diferentes não é detectada: cada destino tem o seu `kind` e o seu `caller_key`.
- Sem worker nem boot: um `submitting` deixado por uma queda só vira `unknown` quando a repetição chega (§12.4).
- Sessões de outra pasta ligadas pela pessoa só valem se aparecerem entre os integrantes; a descoberta não as mostra se estiverem fechadas.
- Um integrante que a pessoa elevou para `edits` ou `full` não recebe delegação até a pessoa baixar a política (§12.3, item 5): é a leitura literal de "nunca converter um vínculo em Acesso total". Se a pessoa quiser delegar a integrante elevado, é decisão dela.
- Entrega durável do resultado ao pai, `ProviderSessionRef` e `ContextTransfer` (§2.2): Fase 4 restante.
- Desempenho não medido.
