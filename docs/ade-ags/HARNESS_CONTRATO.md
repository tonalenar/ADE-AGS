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

### 1.1 As 19 capabilities

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
| `plan` | O ADE consegue iniciar a execução em modo nativo de planejamento? | criar um DAG de tarefas do ADE na Frota |
| `checkpoint` | Há foto do estado da execução? | foto da conversa (nenhuma superfície tem) |
| `rollback` | Dá para voltar ao estado de uma foto? | reverter a conversa do provider (nenhuma superfície faz) |
| `usage` | Há uso de tokens, custo ou limite por sessão? | medidor por conta |
| `event_source` | Há fonte contínua de eventos que o ADE lê? | qualidade da fonte (vai na observação) |

**Escopo** (`instance`, `session`, `model`): onde o estado é decidido. A tabela estática traz o valor padrão por instância. O valor por sessão e por modelo é resolvido na execução (Fase 3). O caso mais claro é o ACP local: a retomada só existe se o agente anunciar `resume` ou `loadSession` no `initialize` (`conversa/opencode.rs:283-287`), então a coluna `local-acp` marca `Unknown` até o descritor de sessão ler `agentCapabilities`.

### 1.2 A matriz

`S` = `Supported`, `?` = `Unknown`, `U` = `Unsupported`. A última linha de cada tabela, `ags_mcp`, não é uma das 19 (ver §1.5). Evidência, escopo, prova e observação de **cada célula** estão em `src-tauri/src/harness/matrix.rs`.

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
| `plan` | S | U | S | S | S | U |
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
| `plan` | U | U | U | U | U | U | U | U |
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
| `compact` | ? | U | ? | U | U | U | U | U |
| `goal` | ? | U | U | U | U | U | U | U |
| `plan` | S | U | U | U | U | U | U | U |
| `checkpoint` | S | S | S | S | S | S | S | S |
| `rollback` | S | S | S | S | S | S | S | S |
| `usage` | S | U | S | S | U | U | ? | U |
| `event_source` | S | S | S | S | S | S | S | S |
| `ags_mcp` (extra) | S | U | S | S | U | ? | U | U |

### 1.3 Contagem

São 22 colunas (6 de conversa, 8 da Frota, 8 de TUI) × 19 capabilities = **418 células**: **167 `Supported`, 32 `Unknown`, 219 `Unsupported`**. Há ainda 22 células `ags_mcp` (fora das 418): 10 `Supported`, 3 `Unknown` e 9 `Unsupported`. O teste `a_contagem_do_doc_concorda_com_a_matriz` falha se esta tabela e `matrix.rs` divergirem.

<!-- contagem-matriz:inicio -->
| Superfície | Provider | Supported | Unknown | Unsupported | `ags_mcp` |
|---|---|---:|---:|---:|---|
| Chat | claude-code | 14 | 2 | 3 | Supported |
| Chat | codex | 14 | 0 | 5 | Supported |
| Chat | opencode | 9 | 1 | 9 | Supported |
| Chat | antigravity | 9 | 0 | 10 | Supported |
| Chat | cursor | 8 | 0 | 11 | Unsupported |
| Chat | local-acp | 6 | 3 | 10 | Unknown |
| Fleet | claude-code | 10 | 0 | 9 | Supported |
| Fleet | gemini-cli | 8 | 0 | 11 | Unsupported |
| Fleet | codex | 9 | 0 | 10 | Supported |
| Fleet | opencode | 9 | 0 | 10 | Supported |
| Fleet | kimi-code | 7 | 0 | 12 | Unsupported |
| Fleet | hermes | 0 | 0 | 19 | Unsupported |
| Fleet | antigravity | 8 | 2 | 9 | Unknown |
| Fleet | cursor | 0 | 0 | 19 | Unsupported |
| Tui | claude-code | 11 | 3 | 5 | Supported |
| Tui | gemini-cli | 6 | 3 | 10 | Unsupported |
| Tui | codex | 10 | 2 | 7 | Supported |
| Tui | opencode | 8 | 2 | 9 | Supported |
| Tui | kimi-code | 5 | 4 | 10 | Unsupported |
| Tui | hermes | 6 | 3 | 10 | Unknown |
| Tui | antigravity | 5 | 4 | 10 | Unsupported |
| Tui | cursor | 5 | 3 | 11 | Unsupported |
| **Total** | 22 colunas × 19 = 418 células | 167 | 32 | 219 | |
<!-- contagem-matriz:fim -->

Fora da tabela estática: TUI custom e ACP custom herdam só o que a pessoa declarou (`agents/adapter.rs:262-274`); `bash` não é agente.

### 1.4 O que falta provar (`Unknown`)

Cada linha é uma pendência de prova, não uma promessa. Colunas iguais estão agrupadas.

| Onde | Capability | O que falta provar |
|---|---|---|
| chat/claude-code | `compact` | captura real recebendo `/compact` como linha `user` e o evento que marca a conclusão |
| chat/claude-code | `goal` | evento do Claude com o status do objetivo e prova de que `/goal` como linha `user` é executado |
| tui/claude-code | `compact` | captura real de `/compact` executado na TUI e evento observável de conclusão |
| tui/codex | `compact` | captura real de `/compact` executado na TUI do Codex |
| tui/claude-code | `goal` | captura real de `/goal` executado na TUI e do estado persistente retornado |
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

**`fork` (extra, fora das 19): a conversa nasce como cópia de outra.** Como `ags_mcp`, `ProviderMatrix::fork` não conta nas 418 células: só o chat usa (a pergunta lateral, `conversa/fork.rs`), e o contrato do motor (`EngineCapabilities::session_fork`) lê a matriz, como o `steer` e o `plan`. Um teste confere que os dois concordam.

| Coluna | `fork` | Mecanismo | Ponto estável |
|---|---|---|---|
| chat/claude-code | `Supported` (prova: teste) | `--resume <sessão> --fork-session --session-id <nova>` (`claude_map::Start::Fork`); com a origem no meio de um turno, `--resume-session-at <uuid>` | a sessão inteira com a origem **ociosa**; no meio de um turno, a última mensagem do agente do último turno **concluído** (`chat_run.end_uuid`, o `uuid` da última linha `assistant` do fio principal, gravado no fim de cada turno concluído); sem esse uuid (turnos de antes deste recurso), cai no contexto portátil (`origin-working`, ou `no-stable-turn` no primeiro turno) |
| chat/codex | `Supported` (prova: teste) | `thread/fork` com `threadId`, `lastTurnId`, `cwd`, `approvalPolicy`, `sandbox`, `model` e `excludeTurns` (`codex::fork_params`) | o último turno **terminado** (`chat_run.status != inProgress`), mesmo com a origem trabalhando; sem turno terminado, contexto portátil (`no-stable-turn`) |
| demais colunas do chat, Frota e TUI | `Unsupported` | sem caminho no ADE | a pergunta lateral leva o contexto portátil (`unsupported`) |

**Três desfechos, gravados em `chat_thread.fork_mode`/`fork_reason`:**

| `fork_mode` | Quando | O que a pergunta recebe |
|---|---|---|
| `native` | mesmo agente **e** mesma conta da origem, motor com fork, ponto estável conhecido | a sessão copiada; a pergunta vai sozinha. Com a origem trabalhando, também um digest (≤ 8 000 caracteres) do que ela fez depois do ponto da cópia, como o `prepareSideChatContext` do T3 |
| `portable` | outro agente (`other-agent`), outra conta (`other-account`), motor sem fork (`unsupported`), origem sem sessão (`origin-no-session`), sem ponto estável (`no-stable-turn`, `origin-working`) ou o fork falhou (`failed`) | o histórico da origem como **contexto portátil** (`conversa/fork_portatil.rs`), gravado no fork e posto pelo backend na frente da primeira mensagem |
| `excerpt` | a origem é uma aba de terminal (`origin-terminal`), ou não tem nenhuma fala para levar | o recorte de até 12 000 caracteres que a tela monta (`sideChatContext`) |

**O contexto portátil (formato do T3, `docs/user/portable-handoffs.md`).** É o `handoff::resumo_as(Frame::SideChat, …)`, o mesmo resumo determinístico da troca de agente (nenhum modelo escreve o texto, então não gasta cota), com o enquadramento de pergunta lateral: *responda só à pergunta, não continue a tarefa da origem*. Entra: as falas inteiras da pessoa e do agente (as mais antigas saem primeiro sob o teto de 64 000 bytes, o `HANDOFF_BYTE_CAP` do T3, e o corte é dito), o pedido original e o corrente, o último turno, o plano, os arquivos alterados e **lidos**, e os **comandos recentes** (até 12, com «falhou»/«negado»). Não entra: o raciocínio, o estado das ferramentas, os anexos e a **saída** dos comandos (o T3 leva a saída; a ADE não, por tamanho e por segredo). É DADO, nunca instrução (`untrusted_data`, mensagem `[ADE AGS]` que a tela esconde). A conversa completa fica em `ags chat show <origem>`, que o agente pode ler.

**Segredos e conteúdo sensível (`conversa/redacao.rs`).** O T3 não leva o ambiente nem o raciocínio, mas também não filtra o texto; a ADE filtra, porque o texto pode ir a **outro provedor ou conta**: chave privada (PEM), `Bearer`/`Basic`, tokens de prefixo conhecido (`sk-`, `ghp_`, `github_pat_`, `xox*-`, `AKIA…`, `AIza…`, JWT), usuário e senha em URL, `NOME_DO_SEGREDO=valor`, `--token valor` e, por último, o detector `looks_like_user_secret` do app (a linha inteira sai). Arquivos de nome sensível (`.env`, `*.pem`, `*.key`, `id_rsa`, `credentials`, `.ssh/`, `.aws/`…) não são nomeados. **Nenhum valor vem do ambiente do processo**: o contexto sai só do que a conversa gravou. É rede de segurança, não garantia: o texto da pessoa continua sendo dela.

**Entrega.** O contexto é uma foto da origem no instante do fork (`settings` `chat.fork.pending.<pergunta>`, sem coluna nova) e só sai da fila quando a mensagem foi de fato enviada (`api::send_mode`): um envio recusado não o perde, e a segunda mensagem não o leva de novo.

**Ponto estável do Claude.** O `--resume-session-at <message id>` existe no binário instalado (Claude Code 2.1.322, conferido em `strings` e com `claude -p --resume <id inexistente> --resume-session-at <x> --fork-session --session-id <y>`, que recusa com «No conversation found» **antes** de qualquer chamada ao modelo; sem `--resume` a recusa é «--resume-session-at requires --resume»). Só vale em modo `-p`, que é o que a ADE usa. O uuid é o da mensagem do agente no transcript (o T3 usa os mesmos uuids no rollback e no fork do Claude). Um uuid que não está no transcript faz o processo sair com «No message found with message.uuid of: …»: o fork falha e a pergunta cai no contexto portátil (`failed`), sem tocar a origem. **Não foi exercitado com uma sessão real do Claude** (rodar uma sessão gasta cota e abriria um processo de agente), então a célula segue `Proof::Test` e não alega `RealCapture`. Risco conhecido: a cópia lê a transcrição enquanto a origem ainda escreve nela; a linha final, ainda incompleta, fica depois do ponto de corte.

Fallback explícito: o motivo (`unsupported`, `origin-terminal`, `origin-no-session`, `other-agent`, `other-account`, `origin-working`, `no-stable-turn`, `failed`) fica em `chat_thread.fork_reason` e a tela o mostra (`chat.sideChat.forkNote` no recorte, `chat.sideChat.portableNote` no contexto portátil). A sessão só abre no mesmo agente e na mesma conta da origem (a sessão vive no perfil da conta). Nenhum dos caminhos toca a origem: o fork só lê o banco e abre outro processo com outra sessão. A prova é de teste com fixtures (`conversa/fork_test.rs`, `conversa/fork_portatil_test.rs`); **nenhum fork foi exercitado com um agente real**.

**Retomada automática de tarefa na Frota × Hand-off manual para aba (`resume`).** O §1.1 define `resume` como: a sessão nativa volta depois de reiniciar o app. Na Frota, o boot do app faz varredura (`store.rs:1256-1300`) e marca tarefas `ready`/`running` como `failed`, não havendo relançamento ou retomada automática da tarefa (`Unsupported`). Há, contudo, uma tensão com essa definição: `run_hand_off_task` (`runs/mod.rs:1116-1157`) reabre a sessão nativa numa aba com `--resume`, o que é hand-off manual ao usuário em terminal interativo, e não retomada da tarefa depois de reiniciar o app.

**Escopo das superfícies.** `checkpoint` e `rollback` valem **só para arquivos** na Frota (ref oculta, `runs/checkpoints.rs:113-151`) e nas abas de TUI (`tab_checkpoints/`). Nenhuma superfície volta a conversa do provider. Na conversa estruturada as duas são `Unsupported`.

### 1.6 Divergências que este contrato corrigiu nos inventários

| # | Inventário | Afirmação | O que o código mostra | Efeito na matriz |
|---|---|---|---|---|
| D1 | `cursor-replay` §1.1 #12 | `resume::open_resuming` "só Claude e Codex" | Também o OpenCode: `claude.rs:190`, `codex.rs:285`, `opencode.rs:231`. Cursor e Antigravity **não** usam `open_resuming` e não devem: têm um processo por turno e o prompt sai junto com `--resume`/`--conversation`. Usam `resume::run_turn_resuming` (`cursor.rs:243-267`, `agy.rs:224-248`, `resume.rs:176-199`), que só recai numa sessão nova com prova de recusa antes do turno (§11.12) | Inventário errado no ponto. A célula de `resume` de cursor e agy cita o guarda e os testes dele |
| D2 | `claude-codex` §1 #3 e plano §3 | `mark_unknown_outcomes` "não roda no fim normal" | **Parcialmente certo**, depende do motor: tabela em §1.7 | Registrado em §1.7. Corrigido depois da Fase 3 para OpenCode, Antigravity e Cursor (o fim normal também marca); as células `tool_events` desses motores citam a correção. As de Claude (`tool_events`) e de Codex (`turn_completion`) seguem citando a correção anterior; o estado delas não muda |
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

A função marca como "desfecho desconhecido" as ferramentas `Running` de um turno (`conversa/turn.rs:82-111`, que chama `mark_unknown_outcomes_except`; as exceções vêm do motor). Quem a chama:
- `turn::record_end`, em **qualquer** fim: normal, interrompido ou com erro (`turn.rs:67-74`). A lista de exceções é vazia nos motores de `turn::finish` (OpenCode, Antigravity, Cursor e a queda do Codex), pelo critério abaixo;
- `claude::gravar_fim`, em **qualquer** fim do turno do Claude (`claude.rs:455-471`), com as exceções da regra abaixo;
- `codex::gravar_fim`, no `turn/completed`, com **qualquer** `status` (`codex.rs:539-549`);
- `close_orphan_runs`, no boot, só para turnos ainda `inProgress` (`conversa/store.rs:1068-1082`).

| Motor | Fim pelo protocolo | Queda do processo com turno aberto | Boot |
|---|---|---|---|
| Claude | `Out::Done` → `finish_turn` (`claude.rs:440-453`) → `gravar_fim`: **marca** em `result` normal, interrompido ou com erro, **exceto** as tarefas em segundo plano com o processo vivo | `closed()` → `finish_turn` (`claude.rs:368`), sem exceção: **marca tudo** | marca |
| Codex | `turn/completed` → `gravar_fim` (`codex.rs:539-549`): **marca em qualquer `status`**. Não roda `pool::after_turn`, como antes | `closed()` → `turn::finish` (`codex.rs:480`): marca (queda é erro; fechar de propósito é interrupção) | marca |
| OpenCode | `turn::finish` (`opencode.rs:814`): **marca em qualquer fim** (normal, interrompido ou com erro), sem exceção (critério abaixo) | `turn::finish` (`opencode.rs:589`): marca | marca |
| Antigravity | `turn::finish` (`agy.rs:214`): **marca em qualquer fim**, como o OpenCode | idem (EOF sem `result` vira erro) | marca |
| Cursor | `turn::finish` (`cursor.rs:233`): **marca em qualquer fim**, como o OpenCode | idem | marca |

**Exceção das tarefas em segundo plano (Claude).** O evento `task` de começo com `is_backgrounded: true` diz qual `tool_use` a lançou (`tool_use_id`). `tarefa_em_segundo_plano` (`claude.rs:473-480`) guarda esse id em `Session.background`. Com o processo vivo, o fim do turno não marca esse item: o desfecho dele vem pelo canal de tarefas (`task_notification`, ou o `stop_task` que encerra a tarefa). A exceção vale para a tarefa viva e para a já encerrada, porque nos dois casos o desfecho já chega pelo canal. Se o processo cai ou é fechado, nenhuma exceção vale: o canal morre com ele, e o item fica marcado. O Codex não precisa dessa exceção: `collabAgentToolCall` e `subAgentActivity` não viram item da timeline, só vão ao painel de tarefas.

**Exceções por motor (critério).** Uma ferramenta só fica de fora da marcação se o motor garante que ela segue depois do fim do turno pelo próprio canal. Só o Claude tem esse canal (a tarefa em segundo plano com o processo vivo, acima). Para OpenCode/ACP, Antigravity e Cursor a lista de exceções é vazia, com estas citações do `record_end` (`turn.rs:56-74`):
- **OpenCode (ACP):** `session/prompt` só responde no fim do turno (`opencode_map.rs:10-11`), e o mapeador não tem tarefa em segundo plano (nenhuma ocorrência de `background` em `opencode_map.rs`). Um `tool_call` sem atualização final nessa hora não tem quem o feche depois (`opencode.rs:789-826`).
- **Antigravity:** o `result` é o último evento, e cada turno é um processo (`agy.rs:214`, `agy_map.rs:195-242`). O mapeador também não tem tarefa em segundo plano.
- **Cursor:** o turno fecha no `result`, que o `cursor-agent` só manda depois dos shells em segundo plano (`cursor_map.rs:13-15`), ou por silêncio, que não vence com ferramenta `Running` (`cursor_map.rs:155-158`). Um sinal depois do fim de uma chamada desfaz esse fim (`cursor_map.rs:126-127`), então o turno segue até o `result`.
- **Codex:** `collabAgentToolCall` e `subAgentActivity` não viram item da timeline (ver acima): lista vazia, como antes.

**Prova (derivada, não captura real).** `replay_derivado_agy_fim_normal_marca_ferramenta_sem_resultado` e `replay_derivado_cursor_fim_normal_marca_ferramenta_sem_resultado` cortam o frame que fecha a ferramenta em `antigravity-feliz` e `cursor-feliz` (capturas `recorded`). `replay_derivado_acp_fim_normal_marca_ferramenta_sem_resultado` usa uma sequência ACP sintetizada, porque não há captura real de ACP. O controle `replay_derivado_fim_normal_com_ferramenta_concluida_fica_intacta` mostra que a ferramenta concluída não é marcada. Esses testes provam o que o código faz com essa entrada, o mesmo limite de `claude-tool-sem-resultado`: não provam que a CLI real produz `tool_use` sem desfecho num fim normal (em `conversa/test_bancada.rs`).

Lacunas reais, em ordem de risco:
1. **Resolvida nesta correção (fecha o que a Fase 3 deixou aberto)**: OpenCode, Antigravity e Cursor marcam também no fim normal, pelo `record_end` (`turn.rs:67-74`), com a lista de exceções vazia (critério acima). Antes, `turn::finish` só agia em erro ou interrupção.
2. Não há captura real que mostre `tool_use` sem `tool_result` num fim normal do Claude, nem `commandExecution` `inProgress` no `turn/completed` do Codex. As fixtures `claude-tool-sem-resultado` e `codex-tool-sem-resultado` são sintetizadas: provam o que o código faz com essa entrada, não que a CLI real a produz.
3. Tarefa em segundo plano que acaba sem `tool_result` continua `Running` na timeline: o ADE sabe que a tarefa acabou, mas não fecha o item. Já era assim e não muda aqui.
4. **Resolvida nesta correção**: `turn::finish` emite à janela os itens que `record_end` marcou (`turn.rs:43-54`), como Claude e Codex já faziam. Antes, a tela só os via ao recarregar.

**O que foi e o que não foi verificado nesta correção.** Verificado: `cargo test --lib conversa`, com os testes derivados novos (três falhavam antes da correção e passam depois; o controle já passava) e o teste de que `record_end` devolve à janela o que marcou. Não verificado: o comportamento real da CLI de OpenCode, Antigravity e Cursor quando uma ferramenta termina sem desfecho num fim normal; a emissão de fato à janela (só pela leitura de `turn::finish`, sem teste de janela); a tela.

### 1.8 Conflito do `steer` do Claude: decisão

- **A matriz marca `Supported`, com limite.** Em turno com ferramenta a mensagem entra depois da fronteira da ferramenta (`claude-steer-ferramenta`). Em turno sem ferramenta a resposta corrente não muda e a mensagem vira um novo turno logo depois do `result` (`claude-steer-sem-ferramenta`): o primeiro `result` não traz `STEER_OK`; o segundo, na mesma sessão, traz.
- **A declaração `MidTurnBehavior::Steer` (`api.rs:88`) e a cópia `PROTOCOL_AGENTS` (`chatModel.ts:76`) ficam como estão.** Esta tarefa não muda comportamento nem UI.
- Um teste (`o_steer_do_claude_fica_unknown_ate_haver_captura_real`) fixa o texto da observação. Outro (`a_matriz_do_chat_concorda_com_o_contrato_declarado_do_motor`) amarra a tabela a `Engine::capabilities()`: `mid_turn = Steer` exige `steer != Unsupported`; `Interrupt` exige `Unsupported`; o mesmo para `compact` e `goal`.
- A cópia da tela, que promete só "entra no turno em andamento", continua decisão de produto (§8): a captura sem ferramenta mostra o outro destino.

### 1.9 Comandos e skills no `/` (`comandos`)

Linha fora das 19, como `ags_mcp` (não entra na contagem da §1.3). Diz se o menu do `/` do chat lista comandos e skills que o agente **aceita**, e de onde vem a lista. Quando a célula é `Unknown` ou `Unsupported`, o menu não mostra skill nenhuma daquele agente.

<!-- comandos:inicio -->
| Superfície | Provider | `comandos` |
|---|---|---|
| chat | claude-code | Supported |
| chat | codex | Supported |
| chat | opencode | Supported |
| chat | antigravity | Supported |
| chat | cursor | Supported |
| chat | local-acp | Supported |
| fleet, tui | (todos) | Unsupported |
<!-- comandos:fim -->

- **Fonte nativa do protocolo:** Claude (`initialize.commands`), Codex (`skills/list`) e OpenCode/local-acp (ACP `available_commands_update`). Quando Antigravity estiver numa sessão ACP, o evento alimenta a lista; o adapter Antigravity `agy --print` não abre ACP.
- **Varredura de pastas** (`skills/agent_scan.rs`): Claude (`CLAUDE_CONFIG_DIR`, `.claude/skills`, plugins), Codex (`.agents/skills`, `~/.agents/skills`, `CODEX_HOME/skills`), Cursor (`.cursor/skills` e `.agents/skills`, globais e do projeto) e Antigravity (`GEMINI_HOME/config/skills`, `GEMINI_HOME/antigravity-cli/skills`, mais `.agents/skills` só do projeto). Cursor e Antigravity respeitam limites de bytes/entradas e leem somente o frontmatter; nada é executado e o corpo não é lido. Antigravity ignora `~/.agents/skills`.
- **Conta da aba:** a varredura usa a conta associada à conversa (`chat_thread.account_id` → `agent_accounts.dir`); Cursor e Antigravity tratam esse diretório como `HOME`. Não lê o keyring nem secrets. Sem conta associada, usam o `HOME` do processo.
- **Fora do chat (Fleet e TUI):** não há composer estruturado, então não há menu.
- **Inserção:** `/nome` para Claude, Antigravity, OpenCode e local-acp; `$nome` para Codex e Cursor. O Cursor recebe `/nome` no envio para skills conhecidas. O Claude também recebe a última menção conhecida do texto como `/nome` inicial e o restante como argumento.
- **Provas e limites:** fixture ACP gravada, árvores temporárias sintéticas e vitest. Cursor e Antigravity não foram testados com agente real nesta rodada; comandos nativos do Antigravity ACP dependem de uma sessão ACP que anuncie `available_commands_update`.

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
9. **Cancelamento.** Cancelar o root é parar o turno dele. Descendentes só são cancelados por ordem do pai ou da pessoa, com escopo verificado (Fase 4, §12.x.3). Parar uma conversa filha interrompe o turno dela; cancelar na Frota age na subárvore do run, nunca no lead nem em filhos de chat (`runs/orchestration.rs::cancel_targets`). Nunca se encerra o PTY original de uma sessão conectada.

### 3.4 Reinício do app

O boot chama as reconciliações depois que a janela existe, em `app/housekeeping.rs`, sob o lease descrito no §13:
- **Conversa** (`conversa/store.rs::sweep_orphans`): turno `inProgress` vira `interrupted`; ferramentas sem resultado ganham `TOOL_OUTCOME_UNKNOWN`; pedidos `pending` viram `expired`; tudo numa transação. Nunca reenvia nada.
- **Frota** (`runs/store.rs::sweep_orphans`): `ready` e `running` viram `failed` com `SWEPT_RUNNING_ERROR`; `pending` vira `cancelled`; o status do run é recalculado. Não relança.
- `ipc::other_instance_alive()` continua evitando sweep enquanto uma instância está ativa; a tomada condicional no SQLite fecha a corrida entre boots simultâneos.

O que o contrato acrescenta:
- Todo nó não terminal vira `interrupted` com `end_reason = app_closed` **na mesma transação** da varredura nativa. A reconciliação fica explícita: `end_source = reconciliation`.
- `outcome_unknown = 1` quando havia ferramenta `Running`, ou envio em `submitting`/`unknown` (`chat_child_receipts.delivery_state`).
- Nó `waiting` vira `interrupted`: o processo que esperava a resposta morreu e o pedido expirou. Não se retoma uma aprovação.
- **"Retomar" nunca altera o histórico.** Cria uma nova attempt correlacionada ao nó antigo, escolhida pela pessoa. Só existe onde a capability `resume` for `Supported` e provada. Na Frota headless a correlação não ganha coluna: `resume_task` (`runs/store.rs`) insere outra linha em `run_attempts` com o mesmo `task_id` e `attempt` = anterior + 1. A linha anterior (status, resultado, erro, `events_path`) não é reescrita e o JSONL dela não é truncado. `failed`, `interrupted` e o desfecho desconhecido (`failed` com `MISSING_FINAL_RESULT`) entram sem flag. `done` só entra com pedido explícito. `ready`/`running`, ou uma tentativa ainda aberta, não ganham segunda linha. A rodada automática de correção e o reroute passam pela mesma reserva (`reserve_next_attempt`); o contador operacional `tasks.attempt` continua podendo zerar no reroute, e o de `run_attempts` não. A tela da Frota segue mostrando a linha corrente da tarefa, não a lista de tentativas.

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
| **P0** ferramenta sem resultado ao fim | **feito** (§1.7): fixture `claude-tool-sem-resultado` + teste de banco do `finish_turn` (`gravar_fim`) | **feito**: fixture `codex-tool-sem-resultado` + teste de banco do `turn/completed` (`gravar_fim`) | **feito** (§1.7): sequência ACP sintetizada, sem arquivo de fixture (`replay_derivado_acp_fim_normal_marca_ferramenta_sem_resultado`); não há captura real de ACP | derivado de `antigravity-feliz` (`replay_derivado_agy_fim_normal_marca_ferramenta_sem_resultado`); `requer captura real` da CLI | derivado de `cursor-feliz` (`replay_derivado_cursor_fim_normal_marca_ferramenta_sem_resultado`); `requer captura real` da CLI | Claude e Codex marcam no fim (a fixture fixa a entrada; o teste de banco, o efeito). OpenCode, Antigravity e Cursor marcam também no fim normal (§1.7); as provas deles são derivadas, e a CLI real só se prova com captura |
| **P0** frame final ausente (EOF) | fixture `claude-sem-result-fecha-no-eof` | fixture `codex-sem-turn-completed` | fixture `acp-sem-result-fecha-no-eof` | **gravada** `antigravity-queda` (kill sem `result`) | **gravada** `cursor-queda` (kill sem `result`) | bancada |
| **P0** reinício no meio do turno | teste de banco: `sweep_orphans` + retomada (`--resume`) | idem (`thread/resume`) | idem (`session/resume`, hoje `Unknown`) | teste do guarda `run_turn_resuming` com fakes (`test.rs:779-901`): recusa antes do turno → turno novo com aviso; o resto não repete | idem (`--resume`, mesmo guarda) | teste de banco por motor (o agnóstico já existe: `test.rs:565-597`) |
| **P1** queda no meio com stderr | fixture `claude-queda-com-stderr` | **já há** `codex-comando-falha-e-queda` | fixture `acp-queda-com-stderr` | `requer captura real` | `requer captura real` | bancada |
| **P1** interrupção | **gravada** `claude-interrompido` | **gravada** `codex-interrompido-real` (e `codex-interrupt-antes-do-started`: `-32600` antes de `turn/started`; o ADE segura o Parar e o manda no aviso: `codex_parar.rs`, `test_codex_parar.rs`) | fixture `acp-interrompido` | o kill gravado não separa interrupt de queda | o interrupt é kill, sem mensagem; ver `cursor-queda` | bancada |
| **P1** pedido pendente no fim do turno | fixture `claude-pedido-pendente-no-fim` | parcial: o pedido existe, mas a fixture termina em queda | parcial: o pedido é respondido | não se aplica (sem pedido) | não se aplica | bancada + teste de banco de `expire_requests` |
| **P1** frames fora de ordem | derivada `claude-feliz`: `tool_result` antes de `tool_use` fica guardado e fecha a ferramenta (`Read:done`) | derivada `codex-feliz`: `turn/started` logo após resposta de `turn/start` | `requer captura real` | derivada `antigravity-feliz`: DONE da ferramenta depois do texto | derivada `cursor-feliz`: conclusão de ferramenta depois do texto | bancada; só reordena quadros registrados |
| **P0** stream parcial (texto/ferramenta) | derivada `claude-feliz`, corte no `tool_use` | derivada `codex-feliz`, corte em `agentMessage/delta` | `requer captura real` | derivada `antigravity-feliz`, corte no delta de texto | derivada `cursor-feliz`, corte no início da ferramenta | bancada; oráculo exige turno `aberto` |
| **P0** processo ocioso sem frame final | derivada `claude-feliz`, sem `result` | derivada `codex-feliz`, conserva `thread/status: idle` e remove `turn/completed` | `requer captura real` | derivada `antigravity-feliz`, sem `result` | derivada `cursor-feliz`, sem `result` | bancada; oráculo exige turno `aberto` |
| **P2** turno feliz | **gravada** `claude-feliz` | **gravada** `codex-feliz` | fixture de base | **gravada** `antigravity-feliz` | **gravada** `cursor-feliz` | bancada |
| **P2** filho termina antes do pai | bancada pronta (B2 e B3 resolvidos); requer fixture | bancada pronta (B2 e B3 resolvidos); requer fixture | sem frame de filho (o ACP só tem o cartão `think`) | `requer captura real` | `requer captura real` | bancada |

Contagem da grade (11 cenários × 5 motores = 55 células): **11 com fixture exata** (a queda sintetizada do Codex, as duas ferramentas sem resultado sintetizadas de Claude e Codex, mais oito recorded: feliz de Claude, Codex, Antigravity e Cursor; interrupção de Claude e Codex; EOF de Antigravity e Cursor), **3 parciais** (pedido em Claude, Codex e ACP), **12 variantes derivadas aprovadas** (quatro fora de ordem, quatro cortes parciais e quatro processos ociosos), **29 sem fixture**. As variantes derivadas não contam como capturas independentes. O steer do Claude (`claude-steer-ferramenta` e `claude-steer-sem-ferramenta`) não é linha desta grade.

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

**Antes desta rodada:** Rust **306 linhas em 58 arquivos**; TS/TSX **183 linhas em 55 arquivos**.

**Depois desta rodada:** Rust **298 linhas em 56 arquivos**; TS/TSX **162 linhas em 53 arquivos**. São ocorrências brutas de nomes; ainda incluem escolhas de parser, executável, formato, produto e catálogo. Não representam inferências de capability.

O guarda anterior tinha baseline de **102 comparações diretas**. O guarda ampliado procura decisões de capability por comparação direta, `matches!`, expressões e braços de `match`, `switch` e listas em `.includes(agent)`, `.has(agent)` e `.contains(agent)`, examinando a declaração, condição e ramo. Depois das migrações, o baseline de capability ficou vazio (**0 ocorrências**). A comparação não é uma subtração bruta de 102: o novo critério exclui identidade sem decisão de capability, como escolher parser, CLI, conta ou formato, que pertence ao adapter/registro. `provider_comparisons.baseline.json` registra apenas exceções classificadas; no estado final não há exceções.

### 6.2 Fonte única e critério do guarda

- `harness::matrix` é a fonte de estado das capabilities por provider e superfície; `agents/registry.rs` e os adapters guardam identidade, protocolo e implementação concreta. `harness_capability_matrix` expõe a matriz pelo Tauri, e `harness::matrix::supports` faz a consulta tipada no Rust.
- `Engine::capabilities()` deriva `steer`, `compact`, `goal` e `plan` da matriz. No caminho estruturado, envio, interrupção, compactação, objetivo e criação recusam `Unsupported` com erro explícito. O frontend consulta a mesma matriz por uma store compartilhada; `plan` só habilita o compositor quando a célula está `Supported`. `Unknown` continua distinguível e mantém os caminhos legados existentes onde a interface/API já os oferecia.
- A Frota consulta `Start` antes de iniciar ou atribuir uma execução; o adapter decide se sabe executar headless e orquestrar. Regras de stdin, `result_schema`, prioridade read-only, perfil isolado e atualização de cota posterior pertencem ao adapter headless.
- `watch_db` usa o adapter de conversa para escolher o parser de pressão da janela Claude. Isso não infere a capability geral `usage`: a célula `Usage` significa uso, custo ou limite por sessão, não o contador de contexto.
- O guarda percorre Rust e TypeScript/TSX de produção fora dos adapters/registros e arquivos de teste; em arquivos Rust, ignora o trecho `#[cfg(test)]`. No frontend, `harnessCapabilities.ts` é o registro compartilhado de compatibilidade. Só conta quando há id conhecido, comparação do agente/provider e marca de capability na expressão, declaração, condição ou ramo. Testes sintéticos cobrem `matches!`, expressões e braços de `match`, `switch`, comparações `==`/`!=` e listas nomeadas em `.includes(agent)`, `.has(agent)` e `.contains(agent)`. Escolhas de parser, executável, conta, formato e apresentação sem decisão de capability ficam fora do grupo.

### 6.3 Migrações da rodada

| Área | Resultado |
|---|---|
| Frontend: `steer`, `interrupt`, `compact`, `goal`, `approval`, `start` | Consultas via store única da matriz; seletores bloqueiam `Unsupported`. `plan` também usa a matriz. |
| API e MCP de conversa | `chat_new`, `chat_send`, `chat_stop`, `chat_compact` e `chat_goal` passam pelos gates de `Start`, `Send`, `Interrupt`, `Compact` e `Goal`; as tools MCP compartilham as rotas e recebem erro claro em `Unsupported`. |
| Frota e orquestração | `Start` é validado antes do roteamento/criação de tarefa. Stdin, `result_schema`, read-only, perfis de tarefa, fast mode e refresh de cota são declarados pelo adapter headless. |
| `teamModel.ts` e `watch_db.rs` | O modo de leitura deriva `plan` da célula TUI; o parser de pressão de contexto consulta o adapter em vez de comparar o nome. |
| `plan` | Nova capability em todas as 22 colunas, com evidência e prova por célula. O compositor e os modos de conversa só ativam Plano quando a matriz diz `Supported`. |
| Guarda e baseline | A busca cobre as formas indiretas de §6.2. Baseline anterior: 102 comparações diretas; baseline final: 0 inferências de capability fora do adapter/registro. |

### 6.4 Critério de saída da Fase 0

**Fechado nesta rodada:** nenhuma capability é inferida por comparação de nome fora do adapter/registro. O guarda indireto passa com baseline vazio (**0**); as comparações de identidade que restam escolhem implementação, parser, executável, conta ou apresentação, sem declarar suporte.

**Plano e prova.** `plan` é uma das 19 capabilities em cada coluna. As 22 células de `plan` têm evidência não vazia e prova diferente de `None`, conferidas por teste. Nenhuma delas afirma `RealCapture`; a prova é de código/tabela. O compositor consulta a matriz e só oferece a ação Plano quando a célula é `Supported`.

**Divergência da TUI.** O composer legado ainda aceita `/compact` de Claude/Codex e `/goal` de Claude, mas o contrato não tem captura que prove execução e resposta observável. As três células ficam `Unknown`; a disponibilidade legada não reclassifica a matriz como `Supported`. `Unknown` significa que o ADE não promete o efeito. O seletor de Plano não usa esse fallback.

**`Unsupported` no MCP.** `chat_new`, envio, parada, compactação e objetivo passam pelos gates compartilhados de `Start`, `Send`, `Interrupt`, `Compact` e `Goal`; tarefa da Frota valida `Start` antes do roteamento/criação. A resposta explicita capability, provider e superfície.

**Não sobra lacuna do critério de saída.** Capturas reais de Claude/Codex para `/compact` e de Claude para `/goal` continuam como pendência de prova em §1.4; não impedem fechar o critério, pois suas células permanecem `Unknown`. Nenhum CLI real foi executado nesta rodada.

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
- Leitura do descritor pela UI, IPC ou MCP; correção das lacunas 1 e 4 de §1.7 (feita depois da Fase 3; as lacunas 2 e 3 seguem abertas); migração dos 149 pontos por nome.
- Run da Frota fora de conversa, sessões de TUI e filhos criados com o pai ocioso.

## 8. Decisões em aberto para o usuário

Só o que é decisão de produto ou de autorização.

1. **Texto do «enviar agora» no Claude.** Enquanto o `steer` é `Unknown`, a tela promete "entra no turno em andamento". Manter a promessa, ou trocar para uma frase neutra ("vai para o Claude agora; ele a lê no meio ou logo depois do turno")? O comportamento não muda; muda a cópia nos três catálogos.
2. **Capturas reais.** Provar `Unknown` e criar fixtures `recorded` gasta conta e cota. Autoriza capturas? De quais providers (Claude, Codex, OpenCode, Antigravity, Cursor) e com que teto de turnos? Sem isso, Antigravity e Cursor ficam sem replay.
3. **Reconhecimento do fingerprint do schema.** O `schema-sqlite` está sem registro no commit base. Quem reconhece (o usuário, ou a fase que tocar o schema) e com qual motivo? Enquanto isso o passo de fingerprint do CI falha.
4. **O filho da Frota sobrevive ao turno do pai.** Decidido: continua vivo e o turno não espera. A árvore mostra "N filhos ativos" (§3.3 regra 8).

## 9. O que foi e o que não foi verificado

**Verificado nesta rodada**
- `cd src-tauri && cargo test --lib --bin ags`: biblioteca **2.933 aprovados, 0 falhas, 29 ignorados**; binário `ags`: **53 aprovados, 0 falhas**.
- `cargo test --lib --bin ags harness::test::`: **28 aprovados, 0 falhas**. Confere as 22 colunas e 19 capabilities, todas as provas e citações, a contagem documentada, os estados `Unknown` da TUI, as provas de `plan` e o guarda de padrões indiretos.
- `bunx tsc --noEmit`: passou.
- `bun run check:i18n`: passou; 0 chaves ausentes ou divergentes.
- `bun run check:test-lint`: passou; 40 violações antigas no baseline e nenhuma nova.
- `bunx vitest run src/features/chat src/features/terminal`: **149 arquivos e 1.109 testes aprovados**.
- `git diff --check`: passou. As dependências ausentes foram instaladas com `bun install --frozen-lockfile` (328 pacotes; lockfile sem alteração).

**Falhas encontradas e corrigidas durante a migração**
- `run_plan_rejeita_member_indisponivel_no_roster_antes_de_criar_task`: o primeiro gate de `Start` alterava o erro para provider removido. O gate agora só intercepta um `Unsupported` conhecido; o teste passou isoladamente e na suíte completa.
- `comparacoes_de_provider_nao_crescem_fora_do_adapter_e_registro`: a forma `.contains()` encontrou uma asserção de teste inline. O guarda agora ignora código sob `#[cfg(test)]`; o teste do guarda e o recorte de 28 testes passaram.
- `a_matriz_do_chat_concorda_com_o_contrato_declarado_do_motor` e o fixture de índices de `guarda_encontra_padroes_indiretos_de_capability_sem_contar_identidade` falharam em recortes anteriores por tratar o ACP local como OpenCode e por índices desatualizados; ambos foram corrigidos e passaram na suíte completa.

**Não verificado**
- Nenhum CLI real de agente foi executado. As células `plan` têm prova de código/tabela e nenhuma reivindica `RealCapture`; as capturas pendentes permanecem em §1.4.
- Nenhum teste visual, build ou instalação foi feito. Também não houve push ou PR.
- O T3 (`main` móvel) não foi relido: §2.6 repete o inventário `antigravity-t3.md`.
- Desempenho de `thread_execution_graph` e de árvores profundas continua **não medido**.
- `bun run check:fingerprint` e a suíte Vitest fora de `src/features/chat` e `src/features/terminal` não foram executados nesta rodada.
- `cargo fmt --all -- --check` havia reportado diferenças de formatação em vários arquivos do repositório; não aplicou alterações e não foi reexecutado após este lote.

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
   - §1.2 e §1.3: na auditoria original, a matriz tinha 18 capabilities e 163 `Supported`, 29 `Unknown` e 204 `Unsupported`; a extensão `plan` e a contagem atual de 19 capabilities estão em §1.3.
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
| 4 | `chat_interrupt` (`api::stop`) | **entregue** (segunda fatia, §11.11) | evento e `causation_event_id` (§11.9) |
| 5 | `request_answer` (`answer.rs`) | próxima fatia | o recibo guarda o `request_id` do pedido; responder duas vezes não reenvia ao provider |
| 6 | `task_cancel` (Frota) | próxima fatia | subárvore cancelada uma vez; efeito de filesystem `retry_safe` |
| 7 | `queue_chat_event`/`queue_fleet_event` | **parcial** (segunda fatia, §11.11): `stderr` trocado por sinal recuperável, e conclusão só depois da tentativa | gravar o evento na transação do passo 1 (depende de `chat_send` e `chat_interrupt` migrarem o evento) |
| 8 | worker contínuo | Fase 5, se a prova pedir | `claim_next` em laço, `recover_expired` no boot |

### 11.9 O que as fatias ainda não fazem

- Não há worker em segundo plano: quem aceita o comando também reclama e executa o efeito (o claim com lease já impede dois donos). `recover_expired` roda no boot sob o lease do harness (§13). O replay das falhas de gravação (§11.11) roda na primeira vez que a fila é usada no processo, não no boot.
- Nenhum recibo guarda `event_sequence` nem efeito guarda `causation_event_id`. As colunas existem (aditivas) e ficam `NULL`: o desenho (§11.4) pede o evento gravado na transação do passo 1, o que exige um tipo de evento novo na projeção (`runs/harness.rs`), que está em outra frente. Essa migração fica para `chat_send` e `chat_interrupt` (§11.8, itens 1, 4 e 7).
- Spawn, resposta a pedido e cancelamento não usam recibo nem fila de efeitos. O Parar usa desde a segunda fatia (§11.11), e o núcleo comum (`harness/command.rs`, §11.13) já serve envio e Parar: `request_answer` e `task_cancel` precisam só de um `ReceiptCommand` novo.
- Interrupção do Claude sem captura real: não existe captura de `control_request interrupt` depois de uma linha `user` e antes de o turno mostrar que roda. O ADE espera o primeiro aviso do turno (§11.13) em vez de mandar o `interrupt` às cegas. Falta a captura `claude-interrupt-depois-do-user` (`ADE_REPLAY_MODE=record`) para provar o efeito. O `session/cancel` do ACP antes do primeiro `session/update` também não tem captura.
- O aviso do log só aparece para falhas recebidas com a janela aberta. A conversa não consulta `harness_log_failure` ao abrir, então uma falha de sessão anterior não é mostrada até o replay resolvê-la. Dispensar o aviso vale só nesta janela.
- Nenhum provider real foi executado.

### 13. Fase 5: recuperação e reconciliação

Ao abrir o ADE, `app::housekeeping` toma `harness_recovery_lease` no mesmo SQLite antes de reconciliar recibos/efeitos, intenções de filho, turnos órfãos, tarefas da Frota, permissões e provisionamentos. A migração aditiva do lease e da presença fica em `harness::store::migrate`; `database/schema.rs` e `user_version` não mudam. A reconciliação das intenções (`reconcile_intentions`, §12.9) roda nesse lease mesmo quando outra instância já está aberta; as varreduras que interrompem trabalho continuam de fora nesse caso.

O lease é uma linha singleton (`id = 1`) com `owner` e `lease_until`. A tomada faz `UPDATE` condicional numa transação `Immediate`, aceitando somente linha livre ou vencida. O instante de referência é argumento das funções; o boot injeta `util::now_ts_ms()`. A rotina libera por comparação do dono ao terminar; se o processo cair, outra instância pode tomar depois de cinco minutos. Um segundo boot que encontrar lease válido adia toda a reconciliação. O lease protege o conjunto de sweeps, enquanto o mutex Rust do banco fica livre durante cada operação que não precisa dele. O lease **não** diz de quem é o turno: só impede duas varreduras ao mesmo tempo.

### 13.1 Presença da instância

Cada processo vivo grava uma linha em `harness_instance` (`id`, `pid`, `beat_at`, `valid_until`). O id é um UUID deste processo, armado em `presence::start` antes dos turnos (`app::run::start_ui`). O primeiro batimento é síncrono; um laço renova a cada 30 s (`HEARTBEAT_EVERY_MS`), sem olhar trabalho nem fila. A validade é três batimentos (`PRESENCE_TTL_MS` = 90 s): um atraso do laço não parece morte. `valid_until > agora` é presença válida. O `agora` das funções é argumento; o laço injeta `util::now_ts_ms()`.

O dono do que está em execução é uma coluna aditiva e anulável: `chat_run.owner_instance`, `tasks.owner_instance`, `mission_member_state.owner_instance` e `chat_team_provision.owner_instance` (esta no `migrate` do módulo do time). Entra quando o turno abre (`upsert_run` em `inProgress`), quando a tarefa é criada ou passa a `running` (`create_task`, `mark_running`) e quando um integrante entra em `provisioning`. Sem id de processo armado (os testes que não sobem o laço), a coluna fica vazia.

`conversa::store::sweep_orphans`, `runs::sweep_orphans` e as reconciliações de integrante pulam a linha cujo dono tem presença válida. Dono vazio ou só espaços é dado antigo: a varredura marca como antes. Presença vencida é instância morta: o turno vira `interrupted` e a tarefa `running`/`ready` vira `failed`, como hoje. Pedido de chat de um turno protegido não expira. O Parar de uma conversa (`close_orphan_runs` com conversa dada) não consulta presença: ele fecha o turno de propósito.

O handshake em arquivo (`other_instance_alive`) continua: se ele vê outra instância, o boot não varre. Isso protege dado antigo sem dono. Se o handshake falha e a outra instância está no mesmo banco, a presença é o que segura o trabalho dela. Uma queda só aparece para a varredura depois que `valid_until` vence (até 90 s depois do último batimento).

Testes: `harness::test_boot` com duas conexões no mesmo arquivo temporário e o tempo injetado. A instância B não marca o turno nem a tarefa de A; marca o da presença vencida e o sem dono.

Decisões da reconciliação de efeitos:

- `pending` nunca reclamado continua na fila e o mesmo `client_request_id` pode reclamá-lo. A intenção e o efeito foram gravados juntos no passo 1 (§11.4).
- `running` com lease ainda válido não é tocado. O pedido repetido retorna `submitting`; esperar evita concorrer com o dono que ainda pode estar enviando.
- `running` com lease vencido e `retry_safe = 1` volta a `pending` (ou `failed` por tentativas esgotadas), porque repetir é idempotente.
- `running` com lease vencido e `retry_safe = 0` é consultado pela capability de reconciliação. `chat_send` não tem capability que prove aceitação; portanto recebe `failed/outcome_unknown`, o recibo recebe `unknown` e nunca é executado de novo com aquele id. Nenhum texto ou payload do provider é persistido.
- Os estados do recibo separam a conclusão do envio (`accepted`, `retryable`, `unknown`) do estado do turno e do trabalho posterior. `accepted` significa que o provider aceitou o envio; não significa que o turno terminou, nem que um diff ou checkpoint foi salvo.

O sweep do turno grava `turn.interrupted` na mesma transação em que fecha `chat_run`; o evento guarda a razão legível “O processo do ADE foi fechado ou caiu antes de o turno terminar.” `runs::harness::thread_execution_graph` expõe essa razão em `interruptionReason` no nó do turno, além do evento. Registros antigos sem evento ficam sem razão. Estado de lease vencido fica no recibo/efeito, com `unknown` como motivo operacional; não é apresentado como conclusão do turno.

| Fronteira de crash de `chat_send` | Estado recuperado | Repetição do mesmo id | Máximo de chamadas ao provider |
|---|---|---|---:|
| Antes do commit da intenção | Nenhuma linha | Cria intenção e envia | 1 |
| Após o commit, antes do claim | `prepared` + `pending` preservados | Reclama e envia | 1 |
| Durante o efeito, lease vivo | `submitting` + `running`; boot não toma o lease | Aguarda; depois do vencimento, sem capability, vira `unknown` | 1 |
| Após o efeito, antes de concluir | `submitting` + `running`; desfecho externo não comprovável | Lease vencido vira `unknown`; não reenvia | 1 |
| Dentro da conclusão, antes do recibo final | O passo 4 é uma transação: crash antes do commit reverte efeito e recibo; após o commit ambos ficam finais | Antes: lease vencido vira `unknown`; após: replay de `accepted` | 1 |

Os testes usam fake de envio com contador e instantes numéricos. Não executam provider ou CLI real. A tabela é uma garantia por estado e atomicidade local; o intervalo entre aceitação remota e commit local permanece inerentemente ambíguo para providers sem consulta de idempotência.

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
- Na fotografia da Fase 2, `recover_expired` ainda não era chamado no boot. A Fase 5 adiciona essa chamada sob o lease SQLite (§13).
- Teste visual e a UI: `chatThreadSendOnce` existe em `ipc.ts`, mas nenhuma tela o chama ainda.

### 11.11 Fase 2, segunda fatia: Parar idempotente e falha de gravação visível

**Objetivo:** o Parar (`chat_interrupt`, §11.8 item 4) ganha recibo e efeito como o envio. E uma falha de gravação do log de execução (§11.8 item 7) deixa de ir só ao `stderr`: vira um sinal que a janela e o harness veem e que pode ser regravado.

**Parar com `client_request_id`** (`conversa/stop_receipt.rs`, `api::stop_with_request`)

- Entradas: `chat_thread_interrupt` (Tauri, `client_request_id` opcional), `ags chat stop <id> --client-request-id` (CLI) e `chat_stop` (MCP, `client_request_id` ou `clientRequestId`). Sem o id, o caminho é o de sempre: sem recibo e sem efeito. O comando Tauri devolve `null`; a CLI e o MCP devolvem `{ stopped: true }`.
- Chave: `kind = chat_interrupt`, `caller_key = chat-interrupt:<hash do escopo>`, `request_id`. O hash do payload cobre só a conversa, e o escopo é o de quem chamou (`ui`, `cli`, aba ou conversa do MCP).
- Efeito `chat_interrupt`: `retry_safe = 0` (é o provider), `max_attempts = 3`, lease de 30 s.
- Desfecho, guardado em `result_json.outcome`:

| Desfecho | Quando | `sent` | Recibo |
|---|---|---|---|
| `sent` | o motor mandou a interrupção nesta chamada | `true` | `accepted` |
| `deferred` | Codex com o `turn/start` ainda sem resposta; Claude e OpenCode com o turno ainda sem aviso do agente (§11.13): o Parar fica pendente em `codex_parar` e sai no primeiro aviso do turno | `false` | `accepted` |
| `no_turn` | não há turno: nada vai ao agente; o que ficou aberto no banco é fechado, como antes | `false` | `accepted` |
| erro do motor | o motor não disse se a parada chegou | `false` | `unknown`, e o erro volta à chamada |

- Repetição com o mesmo id: devolve o recibo gravado (`replayed = true`, `sent = false`) e não chama o motor. Lease vivo: `submitting`. Recibo `unknown`: nunca se repete às cegas, porque a interrupção pode ter chegado. O mesmo id com outra conversa falha fechado.
- Claude e OpenCode respondem ok à interrupção mesmo sem turno. Antes, isso contava como `sent`; agora, sem turno, o desfecho é `no_turn` (`api::interrupt`). Agy e cursor não mudaram: têm um processo por turno.

**Falha de gravação do log** (`runs/execution_log.rs`)

- A fila tenta gravar até 3 vezes (`PERSIST_ATTEMPTS`), sem dormir: a espera pelo lock já vem do `busy_timeout`. Falha de chave estrangeira não se repete: a conversa do evento foi apagada, não há onde gravar e não conta como perda.
- Falha de vez: uma linha em `harness_log_failure`, criada no `migrate()` do módulo (aditiva): `scope`, `thread_id`, `task_id`, `attempt_id`, `event_kind`, `payload_json`, `last_error`, `attempts`, `created_at`, `resolved_at`. O erro passa por `sanitize_error`. O payload é o compactado do log, sem texto de agente. A Frota não guarda payload, então a falha dela não é repetida.
- Sinal: a janela recebe `cc-harness-log-failed` e o barramento publica `harness.log_failed`. Os dois trazem `scope`, `threadId` ou `taskId`, `eventType`, `error`, `attempts` e `failureId`.
- Ordem (§11.4): fase, pedido e fechamento saem à janela (`cc-chat-thread`) e ao barramento (`chat.changed`) só depois da tentativa de gravação. `chat.changed` leva `logged`, que vira `false` quando a gravação falhou, para quem espera (`ags chat wait`) saber que o log não tem o evento. Itens e tarefas continuam saindo na hora, sem esperar a fila.
- Replay: na primeira vez que o processo enfileira algo, a fila repete as falhas de conversa abertas (até 200 por vez): regrava o evento e marca `resolved_at`. Uma repetição que falha de novo soma tentativas e fica aberta. Roda uma vez por processo; não há worker nem relógio.
- Se a fila já caiu, o trabalho roda no chamador (`send_or_handle`): o evento não se perde.

**O que muda para quem chama**

- Tela: `chat_thread_interrupt` aceita `client_request_id` e devolve o recibo quando há id. A UI não foi alterada e continua chamando sem o id.
- CLI e MCP: `ags chat stop` e `chat_stop` documentam o id; a skill sobe para 1.68.0.
- O aviso `cc-harness-log-failed` aparece na conversa afetada desde a terceira fatia (§11.13). `logged: false` ainda não tem tela.

**`event_sequence` e `causation_event_id`:** continuam `NULL`, pelo motivo de §11.9.

**O que foi verificado**

- Testes primeiro, com esqueleto que falha por `unimplemented!`: 9 em `conversa::stop_receipt_test`, 3 contratos em `ipc/test.rs` (CLI, comando Tauri e schema do MCP) e 10 em `runs::execution_log_test`. Os 22 falharam com o esqueleto. O guarda de encaminhamento do MCP já passava antes e continuou passando.
- Depois da implementação, os 22 passam.
- `cd src-tauri && cargo test --lib --bin ags`: 2828 passaram, 0 falharam, 30 ignorados. Linha de base do mesmo HEAD: 2804 passaram, 1 falhou, 30 ignorados. A falha da linha de base era de OCR local (`computer_use::capture`); no pós-mudança ela não aconteceu, e rodada isolada passa.
- Avisos do build: 21 antes e 21 depois, com os mesmos arquivos.
- `node scripts/fingerprint.mjs`: ok (`schema-sqlite 96507e01a45b`, `protocolo-ipc 1959c50fc9d7`; nenhum reconhecimento). O `database/schema.rs` e o `ipc/protocol.rs` não mudaram.
- `bun run check:test-lint`: ok, 40 violações antigas no baseline e nenhuma nova.
- `bun run check:catalogs`: ok (a skill e a ajuda da CLI batem com o código).

**O que não foi verificado**

- Nenhum provider real nem CLI real foi executado. Os testes usam um motor de mentira que conta as chamadas.
- Claude e OpenCode sem turno (`no_turn`): o caminho foi lido no código, sem teste com sessão viva.
- Corrida entre um Parar e o primeiro envio de Claude ou OpenCode: resolvida na terceira fatia (§11.13), com testes sem processo. A captura real dessa janela continua faltando (§11.9).
- Falha de gravação com lock real do SQLite não foi provada: a injeção de falha é uma closure.
- Replay só roda na primeira fila do processo, não no boot (§13). Falhas da Frota não são repetidas.
- Desempenho não medido. `ags test affected` e `cargo clippy` não foram rodados.

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

### 11.13 Fase 2, terceira fatia: núcleo comum, Parar na abertura do turno e aviso do log na tela

**Objetivo:** fechar os três itens que a segunda fatia deixou abertos: um núcleo comum para os recibos de comando, a corrida entre o Parar e o primeiro envio no Claude e no OpenCode, e o aviso de falha do log na conversa afetada.

**Núcleo comum** (`harness/command.rs`). `send_receipt` e `stop_receipt` viram tipos que implementam `ReceiptCommand`: a `Spec` (tipo do efeito, limite de tentativas, prazo do lease e o rótulo das mensagens de erro), o `settle` (o resultado vira um `Settlement`: `Applied`, `NotApplied` ou `Unknown`) e as respostas (`replay` e `reply`). O núcleo faz aceitar, reclamar, concluir e a repetição, uma vez só. O que não mudou: a chave `(kind, caller_key, request_id)`, o prefixo `chat-send:` e `chat-interrupt:` e o hash do pedido. Um teste fixa esses valores, porque recibos já gravados dependem deles. `send_receipt_test` e `stop_receipt_test` não foram alterados.

**A corrida** (o guarda de `codex_parar.rs`, agora usado pelos três motores):
- **Claude:** o id do turno nasce antes da escrita da mensagem (`Session::ensure_turn`, sob o guarda). Um Parar que chega daí em diante vê o turno, fica `deferred` e não toca no banco. O `control_request interrupt` sai uma vez, no primeiro aviso do turno (`is_turn_line`: `system/status`, `stream_event`, `assistant` ou `user`), depois das saídas da linha. Uma escrita que falha desfaz a abertura.
- **OpenCode (ACP):** o `session/cancel` sai só no primeiro `session/update` de conteúdo do turno (`is_turn_update`). Um `session/prompt` que responde sem aviso descarta a pendência.
- **Banco:** o fechamento de órfãos do Parar (`api::close_idle_orphans`) roda sob o lock do banco e não fecha nada enquanto há turno rodando ou abrindo (`turn_busy`, que inclui o `starting` do Codex). Se um turno começa entre a decisão e o fechamento, o Parar é registrado nele.

**O `interrupt` do Claude vale depois da linha `user`?** Não está provado, e o ADE não conta com isso. O que as capturas mostram:
- `claude-interrompido`: o `interrupt` chega com o assistente já em streaming (depois do `message` de início) e é honrado (`aborted_streaming`, `still_queued: []`). O aviso escolhido (`stream_event`, `assistant`) cai nesse mesmo ponto.
- `claude-steer-sem-ferramenta`: uma linha `user` escrita no meio do turno não é aplicada na hora. Vira fila e só roda como turno seguinte, depois do `result`, com um `status: requesting` novo.
- A resposta ao `interrupt` traz `still_queued`: mensagem enfileirada é contada à parte do turno em curso.

Nenhuma captura tem `interrupt` depois de uma linha `user` e antes do primeiro aviso do turno. O Codex tem a prova dessa janela (`codex-interrupt-antes-do-started`: `-32600`), e o Claude não. Por isso o Parar espera o aviso. Se o CLI aceitasse o `interrupt` ali, o custo é um Parar que sai um pouco depois; se não aceitasse, o Parar não se perde.

**O aviso do log na conversa.** A conversa estruturada mostra `LogFailureNotice` (região `role="status"`, sempre no DOM, com o motivo sanitizado e o botão «Dispensar aviso»). O sinal `cc-harness-log-failed` entra no store (`recordLogFailure`) só quando traz `threadId`; a falha de tarefa da Frota não aparece no chat. Dispensar vale nesta janela: a falha continua em `harness_log_failure`. Não cria mensagem no chat.

**O que foi verificado**
- Testes primeiro, sem processo: `conversa::test_parar_turno` (11 testes). Com o guarda do Claude desligado (mutação temporária: o Parar manda o `interrupt` na hora) e sem a checagem de turno ocupado no fechamento de órfãos, quatro testes falham nas asserções certas: o `interrupt` sai antes do primeiro aviso do turno (três casos) e o turno que está abrindo é fechado no banco. Depois da restauração (SHA-256 conferido), os 11 passam.
- `cargo test --lib --bin ags` (a suíte do CI, no estado desta fatia): lib com 2940 passando, 0 falhando e 29 ignorados; bin `ags` com 53 passando. Os 14 testes novos desta fatia estão nessa conta. O teste pré-existente `memory::usage::test::registra_e_aplica_retencao_por_workspace` levou mais de 60 s sozinho, e a suíte inteira 479 s; não investiguei a causa.
- Subconjunto no estado restaurado (`test_parar_turno`, `send_receipt_test`, `stop_receipt_test`, `test_codex_parar`, `harness::test_command`): 53 passam, 0 falham. `send_receipt_test` e `stop_receipt_test` passam sem alteração. O hash e a chave pinados em `test_command` batem com o código.
- Avisos do build: 21, nenhum em arquivo desta fatia.
- `node scripts/fingerprint.mjs`: ok (`schema-sqlite 96507e01a45b`, `protocolo-ipc 8db93c467088`). Nenhum arquivo de schema ou de protocolo foi tocado.
- `bunx tsc --noEmit`: ok. `bun run check:i18n`: ok, 0 achados. `bun run check:test-lint`: ok, 40 do baseline e nenhum novo. `bun run check:babel`: ok, 1390 arquivos.
- `bunx vitest run src/features/chat src/i18n`: 129 arquivos e 947 testes passando, incluídos os 10 novos do aviso.

**O que não foi verificado**
- Nenhum CLI real foi executado. Os testes usam sessões sem processo e o motor de mentira do guarda.
- A captura do Claude com `interrupt` depois de `user` (acima). Falta `claude-interrupt-depois-do-user`.
- OpenCode: a `Session` guarda `AppHandle`, então não há teste de ponta a ponta. A corrida do ACP é provada no guarda (`StopGate`), com a mesma sequência de chamadas de `opencode.rs`. A ordem do `confirm_turn` no `dispatch` do Claude também não tem teste: o `dispatch` precisa de `AppHandle`.
- Falha de gravação com o lock real do SQLite: a injeção continua sendo uma closure.
- O aviso só mostra falhas recebidas com a janela aberta (ver §11.9).
- `codex_parar.rs` manteve o nome, porque a matriz de capabilities e os docs citam o caminho. Renomear é tarefa separada.
- A ordem do `confirm_turn` no `dispatch` do Claude (depois das saídas da linha) não tem teste: o `dispatch` precisa de `AppHandle`. Foi conferida por leitura.
- Um Parar pendente espera o primeiro aviso do turno. Se o Claude ficar mudo com o processo vivo, o Parar espera até o turno acabar ou o processo cair. Não há prazo de reenvio, e essa escolha é do usuário. Um turno que termina sem nenhum aviso de conteúdo descarta o Parar pendente.
- `cargo clippy --all-targets` não foi rodado. A linha de base do HEAD, antes desta fatia, não foi medida nesta sessão. Desempenho não medido.

## 12. Fase 4: delegação única (`delegate_agent` com três destinos)

**Objetivo:** o orquestrador escolhe **onde** o trabalho vai, de forma explícita, e a mesma pergunta repetida nunca vira prompt duplicado em nenhum dos três caminhos. Núcleo de backend. A entrega durável do resultado ao pai e a `connected_session` no painel fecharam depois, em §12.9.

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
- ~~Entrega durável do resultado ao pai~~ **fechada em §12.9** (modo `async` dos três destinos). Continua aberto: `ProviderSessionRef` e `ContextTransfer` (§2.2).
- ~~`connected_session` fora do painel~~ **fechado em §12.9.6**: a projeção e a árvore mostram a sessão conectada.
- Desempenho não medido.

## 12.9 Entrega assíncrona e persistente do resultado do filho (Fase 4, o que ficou aberto)

**Objetivo:** um filho delegado com `mode = async` (conversa filha, tarefa da Frota ou sessão conectada) termina, e o resultado chega ao pai **mesmo que o app feche no meio**, como dado não confiável, limitado, **uma única vez**. Código: `harness/child_delivery.rs` (tudo em SQL sobre `&Connection`, sem relógio nem app), o laço em `ipc/commands/child_delivery.rs`, o registro nos três pontos de delegação (`ipc/commands/conversas.rs::chat_new`, `runs/orchestration.rs::delegate_task`, `ipc/commands/delegate.rs`) e a projeção em `runs/harness.rs`. Testes: `harness/child_delivery/test.rs` e `harness/test_boot.rs`.

### 12.9.1 O desenho em quatro peças

| Peça | O que é | Onde |
|---|---|---|
| Acompanhamento | uma linha por filho delegado em `async`, gravada **na mesma transação** que cria o filho: tipo, filho, pai (`thread:<id>` ou `tab:<id>`), título, agente, turno de origem do pai, e (sessão) a mensagem de delegação. Estado `watching`. Se a criação sai do SQLite (processo ou aba), a linha nasce antes, em `intended`, e o boot a promove ou cancela | `harness_child_watch` (aditiva, criada por `child_delivery::migrate`, chamada de `harness::store::migrate`) |
| Efeito | o **fim** vira um efeito `child_result`, `retry_safe = 1`, `max_attempts = 5`, lease de 60 s, chave `child_result:<tipo>:<filho>` | `harness_effect` (Fase 2) |
| Recibo | `kind = child_result`, `caller_key = <pai>`, `request_id = <tipo>:<filho>`; fica `accepted` quando entregue e `retryable` quando o pai estava fechado | `harness_command_receipt` (Fase 2) |
| Aviso | uma mensagem `notice` (raw) do pai para ele mesmo na fila durável, `client_id` próprio | `peer_queue` (a mesma fila e o mesmo entregador do vigia do chat) |

`mode = wait` **não** registra nada: o pai já recebe o resultado na própria chamada, e um segundo aviso seria duplicata. Sem registro, um filho que termina nunca gera entrega.

**A mesma transação, ou uma intenção.** `chat_new` em modo async (`create_child_async`) grava o acompanhamento no mesmo `COMMIT` da conversa e do recibo. `delegate_task` grava no mesmo `COMMIT` da tarefa (`plan_tasks_watched`). Desfazer a transação desfaz os dois; não fica filho sem acompanhamento. A sessão conectada (`ipc/commands/delegate.rs`) manda a mensagem para uma aba ou um processo antes de saber o `message_id`: a linha nasce `intended` **antes** do envio e, com a mensagem aceita, passa a `watching` (`activate`). No boot, dentro do lease do §13 e **antes** das varreduras, `reconcile_intentions`: intenção cujo filho existe (conversa, tarefa ou mensagem `delegate:<pedido>` que não foi recusa) vira `watching`, e o id da mensagem entra na linha; intenção sem filho vira `cancelled` e não gera entrega. `settle` só olha `watching`.

O resultado **não é copiado** para tabela nenhuma do harness. Na hora de entregar (e de desenhar o painel), `inspect` lê o registro nativo do filho (a fala do agente em `chat_item`, `tasks.result`, a resposta na fila). O efeito e o recibo guardam só ids e o canal (`peer:<id>`); um teste confere que o texto do agente nunca aparece neles.

### 12.9.2 O que conta como "fim" de cada tipo de filho

| Tipo | Fim | Resultado |
|---|---|---|
| `provider_chat` | o **primeiro** turno (`chat_run`) da conversa filha chegou a estado terminal (`completed`, `failed`, `interrupted`; status desconhecido vira `interrupted` com `outcomeUnknown`). Turno em andamento, mesmo esperando pergunta ou aprovação, não é fim. Os turnos seguintes são pedidos explícitos do pai (que usa `chat_wait`) e não geram entrega | a última fala do agente nesse turno |
| `fleet_task` | `tasks.status` terminal pelo mesmo mapa de `harness::state::from_task` (`done`, `failed`, `cancelled`, `skipped`, `handed_off`; a tarefa varrida no boot é `interrupted`, nunca `failed`) | `tasks.result`; sem ele, o erro gravado em tarefa que falhou |
| `connected_session` (terminal ou Gemini Desktop) | **a resposta da sessão ao pai** (`peer tell`/`handoff`/`ask` da sessão para o pai, depois da mensagem de delegação). Sem resposta não há fim observável: o nó segue `running` e nada é entregue | o texto da resposta |
| `connected_session` (conversa `thread:<id>`) | a resposta acima, **ou** o primeiro turno aberto pela delegação terminou (até 10 s antes da mensagem, como o vigia) sem resposta | a resposta, ou a última fala do agente no turno |

Registro nativo apagado antes do fim (a pessoa apagou a conversa ou a tarefa): `child_gone`, nada é entregue.

### 12.9.3 Onde o resultado aparece no pai, e por que assim

**Mensagem enfileirada para o próximo turno do pai, não item de timeline nem `steer`.** A fila durável tem um consumidor por destino, em ordem, que só digita com o pai livre (conversa sem turno aberto; terminal em silêncio). Assim o aviso:
- **nunca interrompe um turno em andamento** (o contrário de um `steer`, que entraria no meio do raciocínio do pai);
- **sobrevive ao app fechar** (a fila é uma tabela) e chega quando o pai estiver livre depois de reabrir;
- é **dado, não ordem**: leva o cabeçalho `[Resultado de filho delegado via ADE AGS]`, o desfecho, e o texto do filho dentro de `<untrusted_data source="child:<tipo>:<filho>">…</untrusted_data>`, numa linha só (o texto do filho não cria linhas novas nem fecha ou abre o envelope: `</untrusted_data` e `<untrusted_data` dentro do texto viram `…-data`).

Um item de timeline sozinho não acordaria o agente pai, que não leria o resultado. O painel (§12.9.6) mostra o mesmo resultado, marcado, em qualquer caso.

**Limite:** até 1000 caracteres do resultado entram no aviso (a mensagem inteira fica abaixo de 1500, o limite em que a fila passa o texto por arquivo). Passou disso: `truncated="true"` no envelope e a frase "resultado cortado em 1000 caracteres; leia o resto em `chat_show <id>` / `task_result <id>`". O painel corta em 500, como antes.

### 12.9.4 Exatamente uma entrega, mesmo com queda no meio

1. **`settle`** (puro): para cada acompanhamento `watching` cujo filho terminou, numa transação: `receipts::begin`, `effects::enqueue` (a chave de dedupe impede o segundo efeito) e acompanhamento → `ended`.
2. **`deliver`**: `effects::claim_next(kind = child_result)`; por efeito, **uma transação só**: `peer_queue::admit` do aviso (com `client_id` próprio) + acompanhamento `delivered` + recibo `accepted` + efeito `completed`. Falhou algo: a transação desfaz, o efeito volta a `pending` (`NotApplied`), e a passada para (a próxima, por evento ou no boot, tenta de novo; passadas as 5 tentativas, `failed`).
3. A chave do aviso é `harness-child-<tipo>-<filho>`; a fila reconhece o mesmo `client_id` do mesmo remetente como repetição (nunca volta, nem depois de entregue: há tombstone).

| Ponto da queda | Estado deixado | O que acontece depois |
|---|---|---|
| antes de `settle` | acompanhamento `watching` | a próxima passada vê o fim e cria o efeito |
| entre `settle` e `deliver` | efeito `pending`, nada na fila | o boot (ou o próximo evento) entrega, uma vez |
| com o efeito reclamado (`running`) | lease de 60 s | enquanto vive, ninguém toca; vencido, `recover_expired` (boot) o devolve a `pending` (é `retry_safe`) e a entrega acontece uma vez |
| dentro da transação de entrega | nada gravado (SQLite desfaz) | idem: refaz a entrega, que ainda não existia |
| depois da transação | `delivered`, efeito `completed`, aviso na fila | nada a refazer; a fila entrega quando o pai estiver livre |
| aviso já na fila por outra via (versão anterior, vigia) | — | `admit` devolve repetição: conta como entregue por referência (`delivered_via = peer:<id>`), sem segunda mensagem |

`recover_expired` roda no boot dentro do lease SQLite da Fase 5 (§13); logo depois das varreduras, `housekeeping` chama `pump` uma vez, o que entrega o resultado de um filho que terminou (ou foi varrido como `interrupted`) com o app fechado. O laço em `ipc/commands/child_delivery.rs` dorme no barramento (`chat.changed`, `task.changed`, `peer.message`), sem polling; só acorda o entregador da fila de cada destino depois de soltar o lock do banco.

**Sessão conectada: sem segunda cópia.** A resposta da sessão **já é** uma mensagem na fila do pai: a entrega só marca `delivered` com `delivered_via = peer:<id>` (nenhum aviso novo). Quando o fim é o turno da conversa da sessão sem resposta, o aviso usa **a mesma chave do «terminou» do vigia do chat** (`chat_team::watch::end_key`): o primeiro que chegar entra na fila e o outro é reconhecido como repetição. Nunca saem dois avisos do mesmo fim.

### 12.9.5 Pai fechado

Decidido no momento de entregar, não antes: `thread:<id>` com `state = 'active'` (a mesma regra do vigia) ou `tab:<id>` com a aba ainda existente. Caso contrário:
- **nada é enfileirado** (um destino sem consumidor só geraria um aviso de falha expirado);
- acompanhamento → `parent_closed`, efeito → `cancelled` (não fica pendente nem tenta de novo), recibo → `retryable` (nada chegou ao pai);
- o resultado continua legível onde sempre esteve: `chat_show` / `chat_wait` (conversa filha), `task_result` (Frota), a conversa ou a aba da sessão, e o nó da árvore se o pai for aberto de novo.

Não há reentrega se o pai "reabrir": a decisão é terminal. Se a pessoa quiser o resultado, ele está no registro do filho.

### 12.9.6 O painel mostra `connected_session`

A projeção (`runs/harness.rs`) lê `harness_child_watch` dos pais da linhagem e emite um nó por sessão conectada acompanhada: `kind = connectedSession`, `id = session:<sessão>#<client_request_id>`, `childType = connected_session`, `title` (o nome pedido), `agentId`, `executionStatus` (`running` sem resposta; o desfecho depois), `origin` (`turn` com o `turnNodeId` **gravado** na delegação, ou `conversation`), `result` (`{ text ≤ 500, truncated, untrusted: true }`) e `outcomeUnknown`. Filho do turno de origem (ou da conversa), conta em `activeChildren` enquanto corre. Só leitura: o nó não tem botão de abrir nem de parar (o painel nunca encerra uma sessão). No front: `HarnessExecutionKind` ganhou `connectedSession`, `HarnessChildType` ganhou `connected_session`, e o rótulo `chat.harness.childType.connected_session` está nos três catálogos; o bloco do resultado é o mesmo da Fase 4, marcado como dado não confiável. Sessão delegada por um **terminal** (`tab:<id>`) não aparece: a árvore parte de uma conversa.

### 12.9.7 O que foi e o que não foi verificado

**Verificado**
- Testes escritos antes: 37 em Rust (`harness::child_delivery::test`) contra um esqueleto `todo!()`: todos falharam. Depois da implementação, passam. No vitest, `harnessConnectedSession.test.tsx`: o teste do rótulo e o do catálogo falharam antes da tela; os outros dois são guarda.
- Rust: fim de cada tipo gera exatamente uma entrega; rodar de novo não entrega outra; turno em andamento não é fim; só o primeiro turno conta; queda entre o fim e a entrega, e com o efeito reclamado (lease vivo e vencido), entrega uma vez; mensagem já na fila com a mesma chave conta por referência; resultado cortado e marcado; texto hostil não fecha nem abre o envelope nem cria linhas; o texto do agente não vai ao efeito nem ao recibo; pai fechado, apagado ou aba inexistente não recebe e nada fica na fila; sessão por resposta, por turno com a chave do vigia, e turno anterior à delegação não conta; `mode = wait` (sem registro) não entrega; a projeção mostra a sessão com tipo, agente, estado, origem e resultado marcado.
- Vitest: `connected_session` aparece na árvore, com os campos acima, sem botão e sem comando de parada.
- Sem relógio real (o `agora` é um número) e sem processo real.
- `harness::test_boot`: duas conexões no mesmo SQLite temporário. Intenção com filho (conversa, tarefa, mensagem de sessão) vira acompanhamento e a entrega sai uma vez; intenção sem filho é cancelada. Rollback da transação que cria a conversa e o acompanhamento não deixa nenhum dos dois. `create_child_async` já grava `watching`. Presença válida de A impede B de marcar o turno e a tarefa; presença vencida e dono vazio são marcados. O prazo vence em `valid_until`, não um milissegundo antes.

**Não verificado**
- Nenhum provider, sessão ou terminal real: o "pai" é uma conversa do banco em memória, e a fila é a tabela. A cola do laço (`ipc/commands/child_delivery.rs`), o registro em `chat_new`/`delegate_task`/`delegate.rs` e a chamada do `housekeeping` **não têm teste de ponta a ponta** (dependem de `AppHandle`).
- O consumidor da fila digitando o aviso no pai (conversa livre, terminal em silêncio) é o de sempre e não foi exercitado aqui.
- Queda entre criar o filho e gravar o acompanhamento: a conversa e a tarefa da Frota nascem na mesma transação, então ou os dois existem ou nenhum. A sessão deixa `intended`; o boot entrega se a mensagem existe e cancela se não existe (`harness::test_boot`, duas conexões no mesmo arquivo, `agora` injetado).
- Sessão de **terminal** que termina sem responder não tem fim observável (não há como o ADE provar). Sessão delegada por um terminal-pai não aparece no painel.
- Corrida entre o vigia e a entrega do mesmo fim na mesma instância: coberta pela chave comum; não testada com dois laços reais.
- Sem captura de tela do nó novo; sem medição de desempenho (a projeção ganhou, por sessão, uma a três leituras).

## 12.x Entrega de resultado e painel (Fase 4)

Fase 4 da auditoria de paridade: o que o pai recebe do filho, o que a pessoa vê e quem pode cancelar. Código: `runs/harness.rs` (projeção), `runs/orchestration.rs` (alcance do cancelamento), `conversa/api.rs` (escopo do Parar) e `src/features/chat/structured/HarnessRunFeed.tsx` (painel). Esta seção tem subtítulo próprio para não colidir com o §12 da Fase 4 de outro integrante.

### 12.x.1 O que a projeção leva em cada filho

Campos novos e opcionais: os nós que não são filhos de agente seguem sem eles. CLI (`run.harnessGraph`) e MCP (`harness_graph`) recebem o mesmo JSON; não há comando novo.

| Campo | Em quais nós | O que é |
|---|---|---|
| `childType` | conversa filha (`provider_chat`), tarefa da Frota (`fleet_task`) e sessão conectada (`connected_session`, desde §12.9.6) | o tipo do agente filho |
| `executionStatus` | conversa filha (estado do último turno), run e tarefa | o estado do §3.1; vira `waiting` quando há pergunta ou aprovação pendente |
| `result` | conversa filha (última fala do agente no último turno) e tarefa (`tasks.result`) | `{ text, truncated, untrusted: true }`; `text` tem no máximo 500 caracteres |
| `blocked` | conversa filha e tarefa | `{ kind: question \| approval, count }`: os pedidos pendentes do próprio filho |
| `blockedChildren` | turno, run e conversa com filho bloqueado | quantos filhos diretos estão bloqueados ou têm um descendente bloqueado |
| `origin` | conversa filha, run e tarefa | `{ createdBy: turn \| task \| conversation, turnNodeId?, taskNodeId? }` |

`status` da conversa filha continua sendo `thread.state` (um teste da Fase 1 fixa isso). Quem diz o que a execução faz é `executionStatus`.

### 12.x.2 Regras

1. **Bloqueio só com turno ou tarefa em andamento.** Pedido do chat (`chat_request` pendente) bloqueia a conversa filha só quando o último turno está `inProgress`. Aprovação da Frota (`task_approvals.status = 'pending'`) bloqueia a tarefa só quando ela está `running`. Pedido que sobrou de turno ou tarefa já terminados não bloqueia: a pessoa não tem o que responder.
2. **Pergunta antes de aprovação.** Quando o filho tem os dois, `blocked.kind` é `question`; `count` soma todos.
3. **Propaga sem mudar o pai.** O bloqueio sobe pela árvore como `blockedChildren` (uma contagem), em cada ancestral. O estado do pai não muda por causa dele (§3.3 regra 6).
4. **Entrega é dado, não instrução.** O `result` sai com `untrusted: true` e, se passou de 500 caracteres, com `truncated: true`. O painel mostra o texto num bloco próprio, com o rótulo "resposta do agente (dado não confiável)"; o texto entra como texto, nunca como HTML.
5. **Origem por id gravado, nunca por `cwd`.** `turn` quer dizer que o turno do pai criou (`turnNodeId`). `task` quer dizer que outra tarefa da Frota delegou (`taskNodeId`), e `turnNodeId` é o turno do run. `conversation` quer dizer que nasceu fora de turno: não há turno para pendurar.
6. **Pedido de aprovação é gravado antes de o agente esperar.** O broker (`runs/broker.rs`) grava `task_approvals` como `pending` antes de bloquear na fila; por isso a projeção, que só lê o banco, vê o bloqueio. O boot fecha os pendentes órfãos (`sweep_orphans`).

### 12.x.3 Cancelamento com escopo verificado

| Comando | Quem pode | O que age |
|---|---|---|
| `run.cancelTask` (MCP `task_cancel`) | a pessoa (pela conversa de origem ou pela pasta), ou uma tarefa **ancestral** da alvo | a subárvore da alvo, no mesmo run, só nas tarefas pendentes, prontas ou rodando. Nunca o lead. Irmã, filho e outra linhagem recebem erro |
| MCP `chat_stop` (`chat.stop`) | a pessoa (sem `caller_scope`), ou a conversa ou aba que criou a filha (`parent_ref` = `thread:<pai>` ou `tab:<aba>`) | só o turno da filha. Tarefa da Frota e pasta, sem conversa de origem, não param conversa nenhuma |
| CLI `ags chat stop` | a pessoa (a CLI não recebe `caller_scope`) | a conversa indicada |

O escopo do MCP vem da sessão: `scoped_chat_payload` carimba `caller_scope` em `chat.send` e em `chat.stop`, e o modelo não escolhe esse campo. **Nunca se encerra o PTY de uma sessão conectada só por deixar de observá-la.** A sessão conectada aparece no painel (§12.9.6) sem nenhum botão de abrir ou parar: o nó é só leitura. O painel só larga os próprios listeners ao desmontar, e um teste confere que desmontar não envia comando de parada nem seleciona conversa.

Lacuna conhecida: a CLI `ags chat stop` roda com a identidade da pessoa. Um agente que chame a CLI pela própria terminal ainda não é barrado. Fechar isso depende de a CLI ser da pessoa, e isso não foi verificado.

### 12.x.4 A tela

`HarnessRunFeed` mostra, em uma linha por filho, o tipo, o agente, o estado, a origem e o bloqueio. O bloqueio vira um botão com nome acessível ("{título}: pergunta pendente"); ativá-lo abre a conversa filha ou, para tarefa, a tela da Frota. A entrega abre um bloco à parte, marcado como dado não confiável. O turno mostra "N filhos bloqueados" e mantém a cor e o estado.

### 12.x.5 O que foi e o que não foi verificado

**Verificado**
- Testes escritos antes do código: 14 em Rust (`runs::test::harness_fase4`, 9, e `conversa::test::harness_fase4`, 5), todos vermelhos antes da implementação; e no vitest (`harnessDelivery.test.tsx`), 5 vermelhos antes da tela. O sexto (desmontar não encerra nada) já passava e serve de guarda. Depois, todos verdes.
- `cd src-tauri && cargo test --lib --bin ags`: 2725 + 52 testes, 0 falhas, 30 ignorados já existentes. Nenhum aviso de compilação nos arquivos tocados.
- `bunx vitest run src/features/chat/structured`: 8 testes, verdes (os 2 de `harnessActiveChildren` e os 6 novos).
- `bunx tsc --noEmit`, `bun run check:i18n`, `bun run check:test-lint` e `bun run check:babel`: sem achado novo.

**Não verificado**
- Visual: nenhuma captura da tela; o painel não foi aberto numa instância isolada. O bloco de entrega e o destaque de bloqueio não foram vistos.
- Ponta a ponta: nenhum provider real foi executado. Pergunta, aprovação e resposta foram gravadas direto nas tabelas nos testes; nenhum adapter emitiu um pedido real.
- Concorrência: a leitura da projeção e a decisão da pessoa correm em transações separadas; não há teste de corrida entre elas.
- Desempenho: a projeção ganhou uma consulta por conversa filha (último turno) e lotes para pedidos e aprovações. Não medido.
- `connected_session` no painel: ver §12.9.6. A regra de não encerrar PTY de sessão conectada vale para o painel (sem botão), sem teste contra um PTY real.

## 14. Fase 6: painel do harness e relação sinal/ruído

Fase 6 da auditoria de paridade: a pessoa ver "quem trabalha, em quê, o que bloqueia e como terminou" sem abrir terminal nem log, com a tela atualizada por evento e sem spam no chat. Código: `runs/execution_log.rs` (cursor e delta), `runs/harness.rs` (projeção), `runs/mod.rs` (comando), e no front `HarnessRunFeed.tsx`, `harnessTreeModel.ts` e `useHarnessGraph.ts` em `src/features/chat/structured/`.

### 14.1 Como a árvore era buscada, e como passou a ser

| | Antes | Agora |
|---|---|---|
| Disparo | evento Tauri, sem polling (`cc-task-changed`, `cc-thread-run-changed`, `cc-chat-thread`, `cc-harness-event` com o id da conversa) | `cc-harness-event` com `{ threadId, cursor }`, `cc-task-changed` e `cc-thread-run-changed`. `cc-chat-thread` deixou de disparar o grafo |
| Leitura | a árvore inteira, com os 250 eventos mais recentes, a cada evento, depois de um debounce de 50 ms (`setTimeout`) | `run_list_harness_graph(threadId, afterCursor)`: os nós sempre atuais e os eventos só como delta |
| Repetição | cada aviso, mesmo repetido, gerava uma leitura inteira | aviso com cursor que o front já aplicou não chama o backend; só há uma leitura em voo, e a rajada vira no máximo uma leitura depois, sem timer |
| Status das filhas | `chat_thread_status` e `chat_thread_requests` a cada `cc-chat-thread`, isto é, a cada trecho de texto | só no aviso de evento persistido com cursor novo, e só para filha que a store ainda não acompanha |

Não havia polling antes: o ganho é o cursor e o delta. Nenhum `setTimeout`, `setInterval` ou `sleep` governa a atualização.

### 14.2 O cursor

- O cursor é `harness_execution_events.sequence`, global e crescente (`AUTOINCREMENT`). O cursor de uma linhagem é o maior `sequence` entre as conversas dela (0 sem eventos). Como a gravação passa por uma fila serial, a sequência cresce na ordem do commit.
- `cc-harness-event` sai depois da gravação, uma vez por conversa afetada, com o payload `{ threadId, cursor }` (`TreeChanged`): o `threadId` e a sequência do último evento persistido **dessa conversa**. Criar uma conversa filha avisa a filha e a pai. O payload não leva texto, rótulo nem frame. Antes o payload era só o id (string); o único ouvinte era o painel, e a mudança é aditiva para ele.
- `run_list_harness_graph(thread_id, after_cursor: Option<i64>)` devolve `cursor` e `reset`:
  - sem `after_cursor`: a janela inteira (até 250 eventos) e `reset = true`;
  - `after_cursor` ≤ cursor da linhagem: só os eventos com `sequence > after_cursor` e `reset = false`;
  - `after_cursor` à frente do banco (o front viu uma sequência que o banco não reconhece): a janela inteira e `reset = true`;
  - mais de 250 eventos depois do cursor: a janela inteira e `reset = true`, porque um delta com buraco não se remenda.
- Os **nós voltam sempre atuais**, com delta ou não. O estado deles vem das tabelas nativas (turnos, tarefas, tentativas), não do log: um delta só de eventos esconderia mudança de status. A economia é o payload dos eventos e o redesenho: o front mantém a mesma referência dos nós que não mudaram (`applyGraphResponse`).
- O front só pede a leitura se o aviso for de uma conversa da linhagem e o cursor passar do aplicado (`shouldSync`). Um aviso repetido ou antigo não chama o backend.
- O motivo da interrupção do turno (`interruptionReason`) deixou de sair da janela de 250 eventos e passou a vir de uma consulta própria (`interruption_reasons`), porque a resposta pode trazer só o delta. Também deixou de se perder quando o turno interrompido sai da janela.
- `run.harnessGraph` (CLI) e `harness_graph` (MCP) recebem o mesmo JSON, com `cursor` e `reset` a mais. Sem `after_cursor`, `reset` é sempre verdadeiro; não há comando novo.

### 14.3 Em andamento versus persistido

Todo evento da lista já foi persistido (tem `sequence`); não existe evento "em memória" na árvore. "Em andamento" é o que **abriu e ainda não tem o evento que fecha**: `tool.started` sem `tool.completed`, `tool.failed` ou `tool.denied` (mesmo `entityId`); `turn.started` sem `turn.ended`, `turn.interrupted` ou `turn.error`; `fleet.attempt.started` sem `fleet.attempt.finished` ou `fleet.attempt.interrupted` (mesmo `attemptId`). O resto é "registrado". A conta é `eventPhases` (`harnessTreeModel.ts`); o evento carrega `data-phase` e o número da sequência no `title`.

### 14.4 A tela

- **Árvore** (`role="tree"`): um nó por linha, em `role="treeitem"` com `aria-level` e `aria-expanded`. A conversa raiz não é uma linha. Só a linha em foco entra na ordem de Tab (roving `tabindex`).
- **Teclado** (`treeKey`): Seta para baixo e para cima andam entre as linhas visíveis; Home e End vão às pontas; Seta para a direita abre o nó e, já aberto, desce ao primeiro filho; Seta para a esquerda fecha o nó e, já fechado, sobe ao pai; Enter e Espaço alternam. Tecla dentro de um botão ou do detalhe é dele e não alterna o nó. Clicar na linha também alterna.
- **Padrão de abertura**: tudo começa recolhido, exceto o nó que tem filho bloqueado (`blockedChildren > 0`), que abre sozinho para a pessoa achar o que pede decisão. A escolha da pessoa vale a partir daí.
- **Cartão resumido (uma linha por nó)**: ponto de estado, título, tipo, agente e modelo, estado em texto, "resultado desconhecido", número de tentativas (na tarefa), origem, filhos ativos e bloqueados, e o bloqueio com o botão que abre a conversa filha (ou a Frota, para tarefa). **Não leva** texto de evento, rótulo de ferramenta, raw frame nem a resposta do filho.
- **Detalhe sob demanda** (`data-detail`, só no DOM com o nó aberto): estado final (ou "em andamento desde"), motivo da interrupção, aviso de resultado desconhecido, a entrega do filho (bloco não confiável, como na Fase 4) e os eventos do nó. Na tentativa, o log do provider (`run_read_attempt_events`) só é lido ao abrir, e uma vez.
- **Estados visíveis em texto, não só em cor**: `aguardando você`, `interrompida`, `cancelada` e `resultado desconhecido`, com `data-state` na linha. O botão de bloqueio mantém o nome acessível "{título}: pergunta pendente".
- **Resultado desconhecido** (`outcomeUnknown`, só quando verdadeiro): status nativo que o ADE não mapeia (`from_chat_run`, `from_task` e `from_fleet_run` com `outcome_unknown`) e tarefa ou tentativa que saiu sem o resultado final (`MISSING_FINAL_RESULT`). Nunca vira conclusão nem falha conhecida.

### 14.5 Consolidação do progresso de baixo nível

`consolidateEvents` separa o que a pessoa precisa ver do que é rotina:

| Fica como marco (linha própria) | Vira resumo (uma linha por trecho seguido) |
|---|---|
| turno iniciado, concluído, interrompido ou com erro; aprovação e pergunta pedidas e respondidas; `tool.failed` e `tool.denied`; conversa e subagente criados; tentativa da Frota iniciada, concluída ou interrompida; objetivo e aviso do runtime | `tool.started`, `tool.completed`, `fleet.tool.started`, `message.user`, `message.assistant`, `turn.usage`, `subagent.item` |

O resumo é só contagem (`N eventos de rotina · X de ferramenta · Y de mensagem`) e a faixa de sequência: nenhum texto de ferramenta ou de mensagem. "Ver todos os eventos" abre cada evento, sob pedido.

**Nada disso cria mensagem de chat.** Os eventos continuam indo só ao log semântico (`harness_execution_events`) e à árvore; o chat não ganha item por evento de ferramenta ou de tela. As notificações que o ADE já manda (Vigia, aprovação, conclusão do filho) não mudaram. Um teste (`harnessTree.test.tsx`) injeta 30 avisos seguidos e confere que a store do chat não muda e que nenhum comando de envio sai.

### 14.6 Aviso sticky de atualização de agente

Regressão proibida: o aviso explícito de atualização de agente fica na tela até a dispensa manual (`sticky` em `src/shared/brand/botToastStore.ts`; `AgentUpdateWatcher.tsx` os cria). A Fase 6 não mexeu nesses arquivos. O teste `src/shared/brand/tests/botToastSticky.test.tsx` prova que aviso novo, em qualquer quantidade, e o tempo (até 7 dias simulados) não o removem, que só o X o fecha, e que o resultado de atualização (sucesso ou falha) nasce `sticky`. Uma mutação que tira o `sticky` do store e do host faz os 7 testes falharem.

### 14.7 O que foi e o que não foi verificado

Ver o relatório de entrega. Em resumo, sem build, sem instância isolada e sem captura de tela: a tela foi exercida só por vitest em happy-dom.

**Fora de escopo e dívida conhecida**
- A janela de eventos (até 250, só metadados) continua indo na primeira leitura; "sob demanda" vale para o detalhe renderizado e para o log do provider, não para o carregamento dos eventos compactos.
- As linhas não são memoizadas por componente: o ganho de redesenho vem de manter a referência dos nós iguais e de não renderizar detalhe fechado. Não medido.
- `cc-chat-thread` não dispara mais o grafo. Estado de nó que mude sem gravar evento nem emitir `cc-task-changed` ou `cc-thread-run-changed` só aparece na próxima leitura. Não encontrei esse caso no código, mas não há teste que o exclua.
