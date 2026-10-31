# Vigia: supervisor das equipes

> Parte do guia de agentes. Índice e regras de ouro: [`AGENTS.md`](../../AGENTS.md). Contexto: [ORQUESTRACAO.md](ORQUESTRACAO.md) e [TROCA_DE_MENSAGENS.md](TROCA_DE_MENSAGENS.md).

O Vigia supervisiona as equipes em segundo plano, sem terminal próprio, e custa pouco. Ele destrava a missão **lembrando o Orquestrador de agir** e conta no chat o que travou e o que fez. Ele não executa tarefas, não interrompe agentes e não decide pelo usuário.

## Regras (não podem quebrar)
- **Nasce desligado.** Quando desligado, roda **só** a detecção de "equipe entregou", que gera um aviso do sistema. Não escreve no chat nem em terminal algum.
- **Nunca escreve num terminal que está trabalhando**, e manda uma cutucada por vez.
- **Só registra no chat depois que a cutucada foi colada de fato** (callback `onSent`).
- "Entregou" e "parei de insistir" saem **uma vez só**. O contador de lembretes zera **só** com uma tarefa nova do Orquestrador; um "ok" não zera.
- `taskAt` (tarefa recebida) só conta quando vem **do Orquestrador**.
- **Laço do Codex: só avisa.** Não interrompe e não troca o modelo, por decisão do usuário (ver regra de ouro 2.4).
- Jev no `delivery_gate`: aceita com **probabilidade ≥ 0,5**. Qualquer falha cai na regra local.
- O prompt da camada 2 manda **ignorar a caixa de digitação** e as sugestões em cinza.
- `startedAt` da missão vem em **segundos** e é convertido para ms (`missionStartMs`). Esse erro já causou o bug A1, em que o Vigia avisava "sem tarefa há 29 milhões de minutos".
- **Os limiares foram calibrados em uso real** (tabela abaixo). Mudar exige medida, e os testes dependem do cooldown de 4 min.
- Os títulos das abas são a chave dos destinos da camada 2. Renomear muda para quem o aviso vai.

## Arquivos
| Arquivo | Papel |
|---|---|
| `src/features/missions/vigia.ts` | núcleo: tick, regras, camada 2, listener `useVigiaDriver` |
| `vigiaClosing.ts` | fechamento antecipado |
| `vigiaLoop.ts` | laço do Codex |
| `vigiaPoke.ts` | `pokeAllowed`, `isFinalReport`, `memberFinished` |
| `vigiaSwitch.ts` | interruptor (`useVigiaSwitch`) |
| `src-tauri/src/missions/vigia.rs` | comandos `vigia_check`, `vigia_report`, `vigia_notify_user` (registrados em `app/run.rs`) |
| `src-tauri/src/decisions/delivery.rs` | `decision_classify_report` (ponto Jev `delivery_gate`) |
| `src-tauri/src/missions/messages.rs` | `record_vigia` (TeamFeed) |
| `src/features/canvas/CanvasDock.tsx` | botão do olho |
| `TeamFeed.tsx`, `teamFeedModel.ts` | `VigiaCard`, `isVigiaMessage`, `parseVigiaText` |
| `missions/terminals.ts` | linha do Vigia no briefing do lead |
| `missions/watcher.ts`, `stalled.ts`, `leadStall.ts`, `stallAlerts.ts` | detectores irmãos (fora do interruptor) |

## Interruptor
- `localStorage` `ags.vigia.enabled`: só liga com `"1"`, então o padrão é desligado.
- Na tela, é o **botão do olho** na barra de baixo do canvas, ao lado do chat (`CanvasDock.tsx`).
- **Ligado**:
  - supervisiona missões `running` **e** times de conversa (`#c:`, com um orquestrador e ≥ 2 terminais ligados);
  - roda o laço do Codex, o fechamento antecipado, as regras e a camada 2.
- **Desligado**: só missões, e só `deliveryOnly`. Detecta "done" e chama `vigia_notify_user(team_delivered)` uma vez por rodada.
- O briefing do lead só menciona o Vigia se ele estava ligado **e** havia um modelo barato instalado no início da missão.

## Estado
- **Fonte de tudo**: o evento `cc-peer-message` `{kind, fromTabId, toTabId, atMs, text}`.
  - Emitido por `peers.rs::emit_peer_message` (tell, ask, handoff) e por `tabs.rs` (`tab send`).
  - Um tell `Duplicate` ou `Unconfirmed` **não** emite, então não conta como tarefa dada.
- **Persistido** em `localStorage`:
  - `ags.vigia.peers.v1`: mapas `sent`, `got`, `task` e `finished` (tabId → ms). **Não expira.**
  - `ags.vigia.watches.v1`: um `Watch{startedAt, nudges, lastNudge, limitReported, doneAt}` por missão. Expira em 3 dias.
- **Volátil**: `lastPoke`, `inFlight`, `lastErrorReport`, `pokes`, `loops` e `closingNudges`. Reabrir o app pode repetir um aviso.
- O listener atualiza os mapas assim:
  - `finishedAt` recebe a mensagem se `isFinalReport` reconhece uma entrega;
  - se não é final, vai ao lead e não é ask, pergunta ao Jev (`askJevIfFinal`);
  - `gotAt[to]` é atualizado sempre;
  - `taskAt[to]` só se a mensagem vem do lead, não é final e não é `isClosure`.
- **Outros sinais lidos**: `lastOutputAt` (atividade do terminal), a tela do xterm e `isWorking`. Este último olha as 8 últimas linhas em busca de `esc to interrupt`, `working (Ns`, `running hooks/tools/command`, `managing tasks` ou `thinking`.

## Limiares
| Constante | Valor | Uso |
|---|---|---|
| `VIGIA_TICK_MS` | 30 s | ciclo |
| `VIGIA_IDLE_MS` | 90 s | ocioso para a camada 2 |
| `VIGIA_COOLDOWN_MS` | 4 min | entre lembretes; reconsulta da mesma aba |
| `LEAD_SILENT_MS` | 3 min | `done` e `silent` |
| `UNTASKED_MS` | 5 min | `untasked` |
| `OPEN_TASK_MS` | 30 min | `open` |
| `NUDGE_LIMIT` | 3 | lembretes por rodada e avisos de fechamento |
| `CLOSING_COOLDOWN_MS` | 3 min | fechamento antecipado |
| `LOOP_MS` / `LOOP_REPORT_MS` | 8 / 15 min | laço do Codex |
| `POKE_PENDING_MS` | 10 min | nova cutucada sem resposta |
| `ERROR_REPORT_MS` | 10 min | erro do modelo no chat |
| `REPORT_MIN_CHARS` | 100 | relatório final sem marcador |
| Jev | ≥ 40 caracteres, envia 600, p ≥ 0,5 | `delivery_gate` |

## Camada 1: regras sem modelo (`watchdogFinding`)
Os membros são o time sem o lead. Para cada um: `hasTask` = recebeu qualquer mensagem; `taskAt`; `reportedAt` = `finishedAt`. As regras são avaliadas nesta ordem:

1. **done** (avaliada antes do cooldown). Condições:
   - ≥ 1 membro com `taskAt`;
   - **todos** com `hasTask`;
   - todos com tarefa reportaram depois dela;
   - lead e membros quietos há ≥ 3 min.

   Ação, uma vez por `doneAt`: chat "**Vigia** — equipe entregou: … Falta só concluir a missão em Missões (Finalizar)", mais o aviso do sistema `team_delivered`.
2. Cooldown: se o último lembrete foi há menos de 4 min, para aqui.
3. **untasked**: há membro sem `hasTask`, a missão tem ≥ 5 min e o lead não mandou nada há ≥ 5 min. Cutucada: "Você ainda não delegou a: X. Mande a tarefa de cada um agora, com `ags peer tell "<nome>" --file <arquivo>`…".
4. **open** (só se não houve untasked): tarefa recebida há ≥ 30 min sem relatório depois dela. Cutucada: "Peça o status a: X, com `ags peer check <nome>`…".
5. **silent**: lead e todos os membros quietos há ≥ 3 min (sem saída nem mensagem), com a missão tendo ≥ 3 min. Cutucada: "Toda a equipe está parada. Veja cada integrante com `ags peer check <nome>`…".
6. Com `nudges ≥ 3`, o achado vira **limit**. Ação, uma vez: chat "já lembrei 3 vezes e não houve resposta. Parei de insistir: reenvie a tarefa ao integrante parado ou finalize a missão."

- As cutucadas de untasked, open e silent vão ao lead como `"[Vigia] " + texto`, só se `mayPoke(lead)`.
- No `onSent`: `nudges++`, `lastNudge = agora`, e o chat recebe `**Vigia** — travado: <motivo> Feito: lembrete n/3 enviado ao <lead>.`
- `refreshWatch`: uma tarefa nova depois de `doneAt` limpa o "entregou"; uma tarefa nova depois do último lembrete zera `nudges` e `limitReported`.

## Como reconhece a entrega final
- `isFinalReport(text, kind, name, toLead)` (`vigiaPoke.ts`):
  - `kind: "handoff"` (`ags peer deliver`): é final por definição;
  - só um `tell` pode ser final; antes de analisar, tira o prefixo `<nome>:`;
  - **marcador explícito** na 1ª linha, sem "?": `entregue | entrega final | trabalho concluído | encerrado | finalizado | concluído | terminei`. Vale para qualquer destino;
  - **ou** é ao lead, a 1ª linha não tem "?", tem ≥ 100 caracteres e não começa com `recebido | ok | entendido | certo | iniciando | começando | aguardando | vou | em andamento | parcial | status | ainda…`.
- `isClosure`: mensagens como "encerrado", "concluído", "sem tarefa", "aguarde", "fique em espera" **não** viram `taskAt`.
- **Jev** (`askJevIfFinal`):
  - pergunta só se a mensagem não foi reconhecida, vai ao lead, não é ask e tem ≥ 40 caracteres sem "?";
  - chama `decision_classify_report`, com os rótulos `final | andamento | pergunta | conversa`;
  - aceita `final` com p ≥ 0,5.
  - O ponto `delivery_gate` nasce desligado. Não envia o que o detector de segredo marca, envia só 600 caracteres, registra no log e faz uma tentativa só. Ver [JEV.md](JEV.md).

## Fechamento antecipado (`vigiaClosing.ts`)
- **Quando dispara**: o lead parou (não está `isWorking`) e as últimas 22 linhas da tela dele pedem autorização. Antes de procurar, remove a caixa de entrada (`❯ › >`) e o rodapé. O padrão (pt/en) cobre:
  - "posso fazer/seguir/finalizar…?", "pode …?", "quer que eu…", "devo…";
  - "aguardo sua autorização/aprovação/ok";
  - "shall/should/can I commit/push/open/merge…", "want me to…".
- **Condição**: algum membro ainda está `isWorking` ou deve relatório (tem `taskAt` sem entrega depois).
- **Ação**: toast, cutucada no lead para esperar ("ainda trabalha" / "ainda não entregou o relatório"; sugere `ags peer ask "<nome>" "status"`) e linha no chat. Cooldown de 3 min, no máximo 3 vezes.
- Enquanto houver fechamento antecipado, o tick **pula** as regras e a camada 2. Sem fechamento, o contador rearma.
- Só lembra o lead; não avisa o usuário.

## Laço do Codex (`vigiaLoop.ts`)
- **Por que existe**: o `gpt-6.1-sol` às vezes emite milhares de itens de raciocínio vazios. Isso aconteceu em 8 de 36 sessões em 09/10/2026, de 13 a 57 min cada.
- **Decisão**: detectar e avisar, sem interromper nem trocar de modelo.
- **Escopo**: só abas `agentId === "codex"` da equipe (o lead incluído), e só com o Vigia ligado.
- **Detecção**:
  1. A tela precisa estar `isWorking`.
  2. A impressão digital são as 40 últimas linhas não vazias, normalizadas: spinners viram espaço; nas linhas de contador (`esc to interrupt`, `context left`, `tokens`), números viram `#` e durações viram `#t`. Números de outras linhas contam como mudança (por exemplo, `Compiling 34/120`).
  3. Avisa se a mesma impressão durou ≥ 8 min, repetindo no máximo a cada 15 min.
- **Ação**: toast e chat "possível laço: X está há N min no mesmo "Working"… Feito: só avisei, não interrompi o agente. Para destravar: Esc no terminal dele e uma mensagem pedindo para retomar de onde parou."
- **Nunca foi exercitado ao vivo**: os testes foram modelados sobre a tela observada.

## Camada 2: modelo barato (`vigia_check`)
- **Roda só se**:
  - o Vigia está ligado;
  - não há fechamento antecipado nem achado da camada 1;
  - não há consulta em voo para a missão, e a missão não está como "entregue";
  - há candidatos ociosos (`idleCandidates`, o lead incluído): sem saída há ≥ 90 s, não consultados há menos de 4 min e que não terminaram a tarefa;
  - há um modelo disponível.
- Antes de chamar, marca todos os ociosos como consultados.
- **Modelo** (`vigiaAgentFor`):
  - lead Codex: `codex` com `gpt-6-luna`, esforço max;
  - lead Claude: `claude-code` com `haiku`, esforço medium;
  - qualquer outro lead: o primeiro instalado (Claude antes de Codex). Nenhum instalado: a camada 2 não roda.
- **Chamada** (`vigia.rs`, em `spawn_blocking`, timeout de 120 s, `cwd` = pasta do lead):
  - Codex: `codex exec --skip-git-repo-check --sandbox read-only -m <modelo> -c model_reasoning_effort="<esforço>" --output-last-message <tmp> <prompt>`;
  - Claude: `claude -p <prompt> --model <modelo> --effort <esforço> --output-format text`.
  - Usa `find_program` e `external_command`. Só conta como erro se o status falhou **e** o texto veio vazio.
- **Entrada**: a tela de cada ocioso e a do lead. Para cada uma, `screen_tail` pega as 40 últimas linhas não vazias, até 2.500 caracteres, já sem ANSI, num bloco `=== TELA DE "<nome>" ===`.
- **Prompt**:
  - "Você é o VIGIA… Você só OBSERVA";
  - classifique cada um como esperando tarefa, terminou e não reportou, esperando resposta, travado num erro ou esperando o usuário;
  - quem está trabalhando não é ocioso;
  - ignore a caixa de digitação;
  - nunca invente tarefas.
- **Saída**: só um array JSON `[{"to","message"}]`, com no máximo 3 itens.
  - Destinos: ocioso, travado ou lead ocioso → o lead; terminou sem reportar → o próprio agente; espera o usuário → `"usuario"`.
  - `parse_actions` descarta mensagem vazia e destino que não seja `usuario` nem um nome das telas.
- **Ações**:
  - `usuario`: toast, aviso do sistema `user_decision` e chat "aviso: … Feito: avisei você na tela: a decisão é sua.";
  - nome de agente: `poke("[Vigia] " + msg)`. Pula se o alvo já entregou ou se `mayPoke` recusa. No `onSent`, chat "aviso: … Feito: mandei a <nome>.";
  - erro do modelo: chat, no máximo a cada 10 min por missão: "o modelo do Vigia não respondeu (…). As regras sem modelo continuam valendo."
- **Custo**: no máximo uma chamada headless por missão em voo, e cada aba é reconsultada só a cada ≥ 4 min. Nenhum processo fica vivo depois.

## Cutucada (`pokeAllowed`, `poke`)
- Nunca com o agente `isWorking`.
- A primeira passa. As seguintes só passam se o agente mandou uma mensagem peer depois da cutucada anterior, ou se já se passaram 10 min.
- O envio é por `sendWhenReady` (`terminalRegistry.ts`):
  - espera a TUI ficar viva e quieta (2,5 s de silêncio, desistindo em 45 s);
  - cola e dá Enter 80 ms depois, repetindo se a colagem ficar pendente;
  - sem terminal registrado, fica na fila e o `onSent` nunca dispara.

## Registro
- **`vigia_report(tabId, text)`**:
  - vai para o chat do **lead** (`~/.ags/chat.json`, `Kind::Say`, sem aviso do sistema);
  - e para `mission_messages`, como remetente "Vigia" (`record_vigia`, `notice=true`), se a aba tiver escopo de missão ou de conversa.
- **Formato** da linha: `**Vigia** — <rótulo>: <motivo> Feito: <ação>`.
  - Rótulos: `travado`, `aviso`, `atenção`, `lembrete`, `possível laço`.
  - No TeamFeed, `VigiaCard` dá a cor: travado = vermelho, lembrete = informativo, os demais = âmbar.
- **`vigia_notify_user(missionId, title, kind, body)`**:
  - `team_delivered`: "Equipe entregou — <título>". Para missões (não para conversas `c:`), grava também o span `team_delivered`, usado em `delivery_split`;
  - `user_decision`: "Decisão pendente — <título>";
  - só aparece com o notificador ligado **e** o app sem foco.

## Detectores irmãos (sempre ativos, fora do interruptor)
Ficam em `watcher.ts`, com tick de 5 s. Os dois ignoram telas com diálogo de aprovação, terminais trabalhando e terminais em que o usuário digitou há pouco.

- **Agente parado** (`stalled.ts`):
  - um tell do lead a um membro (que não seja um ack) abre uma pendência, e qualquer mensagem do membro a fecha;
  - dispara com o membro quieto ≥ **120 s**, configurável por `localStorage` `ags.stallMs` (mínimo 15 s, sem UI);
  - cola no lead "[Aviso automático do ADE AGS] O agente "X" recebeu uma tarefa há … e está parado há …", com a última linha da tela;
  - uma vez por tarefa.
- **Orquestrador parado** (`leadStall.ts`):
  - abre quando um membro pergunta: um `ask`, um `tell` com "?", ou uma pergunta deixada na tela com ≥ 45 s de silêncio;
  - dispara com o lead mudo ≥ **180 s** (`ags.leadStallMs`, mínimo 30 s);
  - cola no lead "[Aviso automático do ADE AGS] O integrante "X" … espera sua resposta há …" e grava o span `orchestrator_stall`.
- Esses detectores reconhecem o lead pelo **título "Orquestrador"**, enquanto o Vigia usa `board.orchestrators`.

## No chat (times de conversas por protocolo)
O Vigia acima só enxerga terminais e missões do canvas. No modo chat, o orquestrador de um time fica ciente dos integrantes (conversas por protocolo) pelo **vigia do chat**: determinístico, sem LLM, sem cota.

- **Onde**: `chat_team/watch.rs` (puro: estado + "agora" injetado → avisos e próximo prazo), `chat_team/watch_db.rs` (lê o banco e põe o aviso na fila) e `ipc/commands/chat_watch.rs` (o laço). O laço dorme no barramento `chat.changed` (fase, pedido, pedido resolvido, conversa fechada, interruptor) e, com um prazo correndo, até ele. Sem polling.
- **O que avisa o orquestrador**, UM aviso por chave (`vigia-chat-*` no `client_id` da fila), marcado `[Vigia do chat]`:
  - **bloqueio**: pedido (`chat_request`: comando, edição, pergunta) pendente há ≥ 20 s; turno que terminou com pergunta/pedido de autorização à pessoa sem resposta; turno que falhou (com o erro);
  - **destravou**: a pessoa respondeu (ou o pedido expirou) o pedido de que ele foi avisado;
  - **sem progresso**: turno em andamento sem item novo há ≥ 15 min (só com o interruptor `watch_stall`; não vale enquanto há pedido pendente, que já é o aviso do bloqueio).
- **Interruptores** (painel Time, só a pessoa): `chat_team.watch` (bloqueios e «destravou», ligado por padrão) e `chat_team.watch_stall` (desligado por padrão, como o Vigia nasce desligado). Colunas aditivas; nada é apagado.
- **Entrega**: `peer_messages` do orquestrador para ele mesmo (`kind: notice`, `raw`), pela fila durável e o `thread_outbox`. Não passa por `peer tell` de agente; de si para si, então a falha do aviso nunca acorda o integrante. A chave já usada nunca volta à fila (nem `unconfirmed` reenvia). Teto de 8 avisos por 10 min por time; o excesso espera a janela andar. Turnos que acabaram há mais de 30 min não geram aviso (o app que abre horas depois não despeja o passado).
- **Regras**: só avisa; nunca escreve na conversa do integrante, nunca interrompe um turno e nunca responde um pedido. A decisão de um pedido é **da pessoa**: o aviso diz isso, e o texto do integrante dentro dele (título, erro, opções) vai numa linha só, cortado e marcado como dado, não ordem.
- **A falha da mensagem do próprio orquestrador** (`unconfirmed`/`expired`) já volta a ele pelo aviso de falha da fila (`failure_notice`); o vigia do chat não a repete.
- **Detecção de «terminou perguntando»**: o último parágrafo da última fala do agente termina em `?`, ou pede autorização/resposta («preciso de autorização», «aguardo sua…»). Heurística conservadora; calibre em `asks_the_person`.
- **Testes**: `chat_team/watch_test.rs` (puro, banco em memória, sem relógio). Prova real com agentes só com OK do usuário.

## Testes
- Front (`src/features/missions/tests/`): `vigia.test.ts`, `vigiaWatchdog.test.ts` (regras, cooldown, limite, `missionStartMs`, `refreshWatch`), `vigiaDelivery.test.ts` (integração com mocks), `vigiaPoke.test.ts`, `vigiaLoop.test.ts`, `vigiaClosing.test.ts`, `vigiaSwitch.test.ts`; irmãos em `stalled.test.ts`, `stallWorking.test.ts`, `leadStall.test.ts`, `stallAlerts.test.tsx`; feed em `canvas/tests/teamFeedModel.test.ts`.
- Rust: os testes de `vigia.rs` (`user_notice`, `parse_actions`, `tail_lines`), `messages.rs`, `delivery.rs` e `decisions/test.rs`.
- Rodar: `bunx vitest run src/features/missions/tests/vigia` · `cd src-tauri && cargo test vigia` · ou `ags test affected`.

## Histórico das decisões
| Commit | O quê |
|---|---|
| 583a2551 (09/10) | versão inicial: um terminal "Vigia" por missão, com modelo barato |
| 4b65fb60 | o terminal some; vira a chamada headless `vigia_check` |
| f820602f | camada de regras sem modelo |
| a842cd67 | bug A1: `startedAt` em segundos comparado com ms |
| 638081c2 | interruptor manual, desligado por padrão; o prompt ignora a caixa de digitação |
| 474ceb4a | reconhece "equipe entregou"; "encerrado/aguarde" deixa de ser tarefa |
| 84a86742 | laço do Codex: detectar e avisar, sem trocar modelo |
| 4877ef18 | `pokeAllowed`: fim das cutucadas empilhadas |
| b391f47b, d6dcbe90 | o Jev confirma o relatório final; recalibrado de confiança ≥ 0,8 para probabilidade ≥ 0,5 |
| adbdc9d2 (14/10) | times de conversa e fechamento antecipado |
| 5865f4d1 (17/10) | fim dos avisos repetidos (o Vigia era 28% do chat, com 34% repetido) |
| 9023333c | a detecção de entrega roda mesmo desligado; aviso do sistema e span `team_delivered` |
| bc9fb22b | `peer deliver` (handoff) é final por definição |

PRs: #143, #145, #147, #148, #149, #154, #158, #179, #182, #184, #185, #203.

## Pontos de atenção conhecidos
- **M4/M5 em aberto**: o `claude -p` da camada 2 não usa a conta do lead (sem `CLAUDE_CONFIG_DIR`) e não restringe ferramentas, embora o prompt leve texto de tela não confiável. Só o Codex roda com `--sandbox read-only`.
- `cwd` com espaço já gerou `os error 267` na chamada do modelo.
- `ags.vigia.peers.v1` não expira, e os mapas voláteis somem ao reabrir, o que pode repetir avisos de fechamento ou de laço.
- **M7**: `done` exige que **todos** tenham recebido alguma mensagem. Um membro nunca acionado bloqueia o "entregou". Além disso, `hasTask` usa `gotAt` (qualquer mensagem), não `taskAt`.
- `untasked` e `open` não olham a saída do membro nem a do lead; só o `mayPoke` protege (M1).
- `toLead`/`fromLead` consideram orquestradores de **qualquer** board.
- O `onSent` altera o objeto `watch` capturado. Se o tick seguinte trocou o objeto por `refreshWatch`, o incremento se perde.
- `sendWhenReady` tem uma fila por aba: uma cutucada pode sobrescrever outro texto pendente.
- Com fechamento antecipado ativo, o tick pula a detecção de `done` e a camada 2.
- O Jev aceita `probability === null`.
- Ruído do modelo: já atribuiu memórias ao integrante errado, pediu para ligar o Vigia já ligado e repetiu avisos sobre quem estava ocioso de propósito.
- Com o Vigia desligado, a entrega gera só o aviso do sistema, que não aparece com o app em foco.
