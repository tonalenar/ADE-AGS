# Teste v15 — Backend: Vigia

Missão mantida: bbe782a6-ec77-4100-8509-b6b1108b09ea (Teste completo v14, rodada v15). Branch mantida: cc/mission-bbe782a6-ec77-4100-8509-5d7ad611. Só documentação; nenhum código do produto alterado. Sem branch nova, push, PR, merge, mudança em Decisões/Contas/chaves ou escrita direta no banco. A janela do app NÃO foi aberta. Observação por código, SQLite em mode=ro, chat.json e snapshots de terminal por CLI.

## Resultado

- **FALHA, média:** avisos do Vigia não aparecem na aba Equipe, padrão do chat da missão; ficam no chat do agente Orquestrador. Confirmado pelo caminho completo de gravação/leitura e pelo Frontend.
- **FALHA, baixa:** duas mensagens de ruído/imprecisão no chat: pedir para ligar o olho já ligado e atribuir seis propostas do QA ao Backend.
- **FUNCIONA na amostra:** um aviso útil sobre o diálogo conhecido do Codex; zero envios diretos do Vigia registrados/observados nos terminais, zero cutucadas em quem entregou e zero pasted text empacado comprovado. Ausência de auditoria de entrega limita o total histórico.
- **FUNCIONA por código/testes existentes:** detecção de Working parado por 8 minutos. Nenhum laço real com tela parada por 8 minutos foi observado na rodada.
- **FUNCIONA, com ressalva:** affected verde; Rust verde por cache, sem reexecução. Esta rodada não mede nova recorrência do flake Rust.

## Marco temporal e método de coleta

O Orquestrador informou que o usuário ligou o olho antes da delegação v15 e não tem horário exato. vigiaSwitch.ts só persiste ags.vigia.enabled como 1/0, sem timestamp. Usamos **2026-10-12 22:23:26 BRT** como primeiro sinal positivo de Vigia ligado (epoch 1791854606). A ativação foi anterior ou igual a esse primeiro registro; não foi assumida igual a ele. Delegação Backend v15: 22:26:19.245 BRT, mission_messages id 22.

SQL aberto somente assim (sem migrations, INSERT, UPDATE ou DELETE):

```python
import sqlite3
c = sqlite3.connect('file:C:/Users/tonz1n/.ags/data.db?mode=ro', uri=True)
c.execute('PRAGMA query_only=ON')
```

Consultas reais:

```sql
SELECT * FROM mission_messages WHERE mission_id=? ORDER BY id;
SELECT id,title,status,started_at,updated_at FROM missions WHERE id=?;
SELECT kind,actor,target,started_ms,ended_ms,detail
FROM mission_timings WHERE mission_id=? ORDER BY started_ms;
SELECT id,title,scrollback FROM tabs WHERE id IN (?,?,?,?);
```

Parâmetro da missão: bbe782a6-ec77-4100-8509-b6b1108b09ea. Fonte equivalente de chat: ~/.ags/chat.json, conversations[a926f8ab-c7f1-4464-abaf-8c308e84dbcb].messages, selecionando text iniciado por **Vigia**. IDs de terminais obtidos de ags peer list; foram usados somente os quatro integrantes desta missão.

Saída exata da leitura SQLite em 2026-10-13 01:27:34.186813 UTC (22:27:34 BRT):

```text
mission [{"id": "bbe782a6-ec77-4100-8509-b6b1108b09ea", "title": "Teste completo v14 (chat da equipe, squad E2E)", "status": "running", "started_at": 1791853414, "updated_at": 1791853414}]
count_messages 24
vigia_messages []
```

Zero Vigia em mission_messages não equivale a zero avisos: vigia_report usa chat.json. Entre 22:27:34 e 22:32:40 BRT, as releituras de chat.json mantiveram os mesmos três IDs; nenhuma linha nova, erro de modelo ou aviso de laço foi registrado nesse intervalo.

## Contagem e textos exatos — chat

**Total: 3 mensagens; 1 útil, 2 ruído/imprecisão.** Todas em kind=say, thread=blue, conversa do Orquestrador; são avisos para o usuário, não perguntas ou mensagens peer a um integrante. Classificação por mensagem inteira; o primeiro aviso tem conteúdo útil sobre propostas, mas uma instrução incorreta, por isso entra em ruído. A utilidade do terceiro foi corroborada pelo QA.

### 1. 2026-10-12 22:23:26.000 BRT — RUÍDO/IMPRECISÃO

ID: d2bea48196; epoch: 1791854606; emissor textual: Vigia; destino da ação: usuário; armazenamento: conversa Orquestrador, blue/say.

```text
**Vigia** — aviso: O Orquestrador terminou o relatório da missão e está aguardando sua decisão sobre as 6 propostas pendentes em "Sugestões de memória" (qa_test_framework_vitest, qa_compiler_tsc_check, qa_syntax_babel_check, qa_backend_rust_cargo, qa_e2e_smoke_validation, qa_code_quality_lint). Se quiser a medição do Vigia, ligue o botão do olho e peça nova rodada. Feito: avisei você na tela: a decisão é sua.
```

O aviso nasceu de um ciclo que exige Vigia habilitado, mas recomenda ligar o olho para medir o próprio Vigia. O usuário e o Orquestrador confirmam que o olho já estava ligado. As seis chaves listadas pertencem ao QA e estão corretas neste primeiro texto.

### 2. 2026-10-12 22:24:35.000 BRT — RUÍDO/IMPRECISÃO

ID: 71f29d8143; epoch: 1791854675; emissor textual: Vigia; destino da ação: usuário; armazenamento: conversa Orquestrador, blue/say.

```text
**Vigia** — aviso: Há 3 memórias do Orquestrador e 6 propostas do Backend pendentes de aprovação na tela de Missões; a equipe está aguardando você. Feito: avisei você na tela: a decisão é sua.
```

A atribuição de seis propostas ao Backend está incorreta: foram criadas pelo QA. Não se confirmou que a origem de “3 memórias do Orquestrador” esteja errada. Local “tela de Missões” é impreciso frente à orientação “Sugestões de memória”.

### 3. 2026-10-12 22:24:35.000 BRT — ÚTIL (situação já conhecida, sem novo bug do modal)

ID: df41e173ca; epoch: 1791854675; emissor textual: Vigia; destino da ação: usuário; armazenamento: conversa Orquestrador, blue/say.

```text
**Vigia** — aviso: A tela do Backend mostra um diálogo 'Set up security' do Codex (chave de segurança) aguardando escolha. Não é da missão, mas pode estar ocupando o painel. Feito: avisei você na tela: a decisão é sua.
```

QA confirmou que o diálogo “Set up security for Daybreak mode” estava visível no painel Backend. O aviso pode ajudar o usuário; o modal é comportamento já conhecido e não foi listado como novo bug. Nenhuma chave foi acessada ou alterada.

Reprodução dos dois avisos imprecisos: após entrega v14, manter Vigia ligado e propostas pendentes; aguardar ciclo headless para agentes ociosos. A ocorrência acima é observada, mas o texto de modelo é variável e não se promete reprodução determinística. Não foi provocada nova chamada ao modelo apenas para tentar reproduzi-lo.

## Mensagens a terminais, pasted text e entregas

| Terminal | Envios Vigia registrados no chat | Mensagens recebidas observadas | Úteis | Ruído | Pasted empacado comprovado | Cutucadas após entrega |
|---|---:|---:|---:|---:|---:|---:|
| Orquestrador | 0 | 0 | 0 | 0 | 0 | 0 |
| Backend | 0 | 0 | 0 | 0 | 0 | 0 |
| Frontend | 0 | 0 | 0 | 0 | 0 | 0 |
| QA / Tests | 0 | 0 | 0 | 0 | 0 | 0 |

Esses zeros representam envios registrados/observados, não uma prova de ausência absoluta em cada instante desde a ativação. As três linhas de chat possuem Feito: avisei você na tela; nenhuma possui mandei a <integrante> ou lembrete enviado ao Orquestrador. O envio direto não passa por ags peer tell, não possui linha mission_messages e não tem auditoria própria de entrega.

Comandos de snapshot, executados às 22:29:17 BRT, e saída exata resumida pelo coletor Python (as saídas JSON integrais foram preservadas fora do repo em TEMP/v15_backend_screens.json):

```text
{"at": "2026-10-13T01:29:17.222264+00:00", "command": "ags peer check Orquestrador --lines 200", "exit": 0, "name": "Orquestrador", "matches": []}
{"at": "2026-10-13T01:29:17.239795+00:00", "command": "ags peer check Backend --lines 200", "exit": 1, "name": "Backend", "matches": []}
{"at": "2026-10-13T01:29:17.260560+00:00", "command": "ags peer check Frontend --lines 200", "exit": 0, "name": "Frontend", "matches": []}
{"at": "2026-10-13T01:29:17.281941+00:00", "command": "ags peer check QA / Tests --lines 200", "exit": 0, "name": "QA / Tests", "matches": []}
```

A leitura de si mesmo por peer check não resolve o nome, pois exclui o próprio chamador; isso não foi classificado como novo bug:

```text
{"error":"'Backend' não está conectado com você. Conectados: Orquestrador, Frontend, QA / Tests"}
```

Alternativa executada: ags tab output 5f61ba24-8d91-4991-8b27-1d14da0fabd6 --raw --lines 100 → exit 0, mode=raw, totalLines=545, truncated=true. A saída contém citações de [Vigia] e código/testes impressos pelo próprio trabalho; não foram contadas como mensagens recebidas. A flag --raw não move o cursor de leitura. Uma leitura anterior sem --raw retornou digest e atualizou apenas o cursor volátil do leitor de saída.

Scrollbacks SQLite são fluxos ANSI com redesenhos, sem timestamp por trecho. Ocorrências literais de #N e [Vigia] incluem briefings, relatórios, código e repintura da TUI; contar substrings inflaria falsamente mensagens. Foram encontrados marcadores reais de colagem no Frontend (#1 do briefing inicial, #3 da tarefa v15) e no Orquestrador (#2/#3/#4 de entregas v14 e #5 da entrega Frontend v15), seguidos de execução/resposta. Não há evidência de que tenham ficado empacados, nem de autoria Vigia.

Horários de entrega v14 comprovados por mission_messages:

- Frontend: 22:05:53.324 BRT, id 4.
- Backend: 22:18:08.234 BRT, id 14.
- QA / Tests: 22:20:08.738 BRT, id 18.

Os três avisos de chat vieram depois dessas entregas; são avisos ao usuário, não cutucadas nos terminais dos integrantes. Os terminais receberam tarefas reais novas da v15 a partir de 22:26, portanto mensagens do Orquestrador dessa rodada não são cutucadas indevidas do Vigia. Nenhuma ocorrência indevida observada para listar horário/texto.

Resposta exata do QA ao Backend, em mission_messages id 32:

```text
Respondendo: Zero ocorrências de [Vigia] e zero de [Pasted text #N] nos snapshots do Backend capturados pelo QA (monitorado entre 22:05 e 22:31). A tela mostrou apenas ferramentas, testes, mensagens de peer e o diálogo 'Set up security for Daybreak mode'. Confirmamos também os 3 avisos em chat.json e nenhum envio direto a terminais.
```

## FALHA: avisos ausentes da aba Equipe

Caminho conferido:

1. src/features/missions/vigia.ts:239-240 chama invoke(vigia_report, {tabId,text}).
2. src-tauri/src/missions/vigia.rs:175-185 chama chat::update(tab_id) e chat::push(Kind::Say), emitindo o evento de chat do agente. Não chama missions::messages::record.
3. src/features/canvas/TeamFeed.tsx:25 consulta somente invoke(mission_messages).
4. src/features/canvas/ChatPanel.tsx:427 renderiza TeamFeed quando teamView; :428 em diante mostra mensagens de chat do agente somente no outro modo. A aba Equipe nasce selecionada em missão (:93).

Reprodução por código/dados: Vigia ligado, aguardar aviso; existem os três registros acima em chat.json e zero registros Vigia em mission_messages. A aba Equipe não tem fonte que possa renderizá-los. Na aba do Orquestrador/thread blue podem aparecer. Não foi aberto o app para confirmar aparência visual.

Confirmação independente recebida do Frontend, id 31:

```text
Frontend→Backend: CONFIRMADO por código. A aba Equipe (teamView, ChatPanel.tsx:93) só renderiza TeamFeed(messages, approvals, notes): messages vem de useTeamMessages = invoke('mission_messages') (TeamFeed.tsx:~21-35), approvals da frota e notes (o que o usuário enviou na sessão). Não lê chat.json nem chat_history, e não há tratamento de 'Vigia' em src/features/canvas (só o botão do olho). Logo os avisos Vigia gravados por vigia_report (chat.json, Kind::Say, thread blue do Orquestrador) só aparecem na aba do agente Orquestrador (chat_history, ChatPanel.tsx:177), NÃO na Equipe. Conserto possível: vigia_report também gravar em mission_messages (from=Vigia) ou o feed mesclar esse chat.
```

## Onde o Vigia lê/grava e limites de entrega

- vigiaSwitch.ts: ags.vigia.enabled em localStorage, sem hora de ativação.
- vigia.ts:196-215: localStorage ags.vigia.peers.v1 persiste sent/got/task por tab. watch/nudges, pokes, loopWatch, inFlight e horários de erro são Maps/Sets voláteis.
- vigia.ts:389-395 lê cc-peer-message; qualquer envio atualiza sentAt e recebimento atualiza gotAt/taskAt, exceto texto reconhecido como encerramento.
- vigia.ts:247-257: laço usa screenOf do terminal xterm; não lê SQLite.
- src-tauri/src/missions/vigia.rs:34-46: o modelo lê scrollback vivo via PTY, strip_ansi e tail_lines, até 40 linhas / 2500 caracteres. Isso não é snapshot reconstruído da tela xterm.
- vigia.ts:230-232: poke marca o horário e chama sendWhenReady. Sem SendTimings/onSent/onStalled, então não confirma paste/submissão/consumo.
- terminalRegistry.ts:177-186: se não há terminal registrado, deixa na fila e retorna. vigia.ts:369-370 pode escrever mandei a ... no chat imediatamente depois de enfileirar. **FALHA de evidência por código, baixa:** esse texto atesta envio sem comprovar recebimento. O caso de terminal ausente não foi provocado no app nesta rodada.

Saída exata da consulta dos kinds existentes em mission_timings da missão:

```text
TIMING_KINDS ["boot", "peer_ask", "peer_message", "start_activity", "start_all_working", "start_briefing", "start_retry", "start_stalled", "test", "turn"]
```

Não há kind de poke ou confirmação de entrega do Vigia. chat.json também só possui id/thread/kind/text/at, sem origem estruturada Vigia, destinatário terminal ou recibo. Registro de bot toast é transitório. Falha de vigia_report é engolida por catch, então pode haver ação sem registro se persistência falhar; isso é limite por código, não falha de gravação reproduzida aqui.

## Regra de já entregou — FUNCIONA no caso final; FALHA de precisão para progresso

memberFinished em vigiaPoke.ts:25 usa apenas reportedAt >= taskAt. vigia.ts:391 define reportedAt para QUALQUER peer enviado, incluindo pergunta/status intermediário. Assim não distingue entrega final de progresso. Exemplo real da própria v14: tarefa Backend id 1, at_ms=1791853450803; pergunta do Backend ao QA id 5, at_ms=1791853701606; status Backend iniciou... Suite rust em execucao id 6, at_ms=1791853707227. Ambos os envios já satisfazem memberFinished, muito antes de BACKEND ENTREGUE id 14, at_ms=1791854288234. Em vigia.ts:345, Backend seria excluído da lista idle após essa pergunta/status, embora ainda tivesse testes a executar. **FALHA por código/dados, média:** um agente pode ser tratado como entregue cedo e deixar de receber observação de ociosidade. O watcher de laço Codex é separado e continua rodando.

Além disso, ações do modelo são pedidas assincronamente (até 120 s no backend). O filtro memberFinished é aplicado antes de invoke; no callback :360-370 só se verifica target e mayPoke, sem rever se o integrante entregou enquanto a consulta corria. **Risco de corrida por código, não observado ao vivo:** uma resposta atrasada poderia cutucar quem acabou de entregar. Não contar como cutucada real nesta amostra.

Os testes existentes de vigiaPoke.test.ts cobrem 10 min de espera, Working bloqueado, resposta posterior e comparação de timestamps. Não verificam se o peer é um relatório FINAL, nem a corrida durante vigia_check. A regra de entrega final simples tem teste coerente; a precisão semântica e assíncrona tem lacunas.

## Aviso de laço após 8 minutos — FUNCIONA por código e cobertura; não exercitado ao vivo

Condição exata: vigia.ts:272 exige habilitado; :274 só missões running; :249 só Codex. watchLoops ocorre antes das decisões de idle/done, portanto não depende de silêncio no PTY. loopStep exige isWorking nas últimas oito linhas não vazias; fingerprint usa últimas 40 não vazias, normaliza spinner, tempo/contexto/tokens nas linhas de contador e conserva progresso de build.

LOOP_MS=8*60000; stuckMs >= LOOP_MS dispara toast 12 s e mensagem no chat **possível laço**, sem interromper o agente. Tick a cada 30 s: aviso no primeiro tick a partir de 8 min observados, sujeito a agendamento da janela. Nova advertência só 15 min após a anterior; mudança de tela/saída de Working/falta de tela reseta o relógio. Relógio é do primeiro snapshot igual observado pelo Vigia, não do contador total que a TUI exibe.

Testes existentes coerentes em tests/vigiaLoop.test.ts:

- Ignorar contadores/spinner e mudança de forma 5s → 1m → 1h.
- Preservar número de progresso de compilação e conteúdo novo.
- Não contar idle/null; não alertar minutos 1–7; alertar exatamente LOOP_MS.
- Não repetir 30 s depois; repetir após 15 min.
- Resetar com tela diferente, idle ou null.
- Comando que produz saída a cada minuto durante 30 min não é laço.

Não houve Codex com fingerprint imutável por 8 min observado na rodada; o Backend chamou ferramentas e mudou a tela. Zero mensagens possível laço em chat.json. Não foi criado laço proposital, interrompido agente, fechado ou reiniciado app. Os testes frontend foram revisados como código; não foram executados de novo nesta v15, pois só Markdown mudou e affected não selecionou essa suíte.

## Suítes — comandos e saídas exatas

Uma única chamada Rust, conforme pedido; cache respeitado:

```text
ags test run rust
{"cacheHit":true,"durationMs":0,"message":"já verde neste hash (há 12 min)","passed":true,"suite":"rust","treeHash":"207454680ecd4b26a38c88be6034e80cfaa81f54"}
EXIT_RUST_V15=0
```

**Ressalva:** não foi nova execução do teste intermitente de matar processo. Não declarar que o flake não recorreu ou que foi corrigido com base nesse cache. Não foi chamada segunda execução --force, preservando a regra uma vez/reutilizar verde. V14 mantém evidência de uma falha e uma aprovação em duas execuções reais.

```text
ags test affected --dry-run
Nada a testar: só arquivos sem efeito em código.
Sem teste (1): docs/ade-ags/V14_BACKEND.md
{"commands":[],"full":false,"ignored":["docs/ade-ags/V14_BACKEND.md"],"risk":[],"unmapped":[]}
EXIT_AFFECTED_DRY=0
ags test affected
Nada a testar: só arquivos sem efeito em código.
Sem teste (1): docs/ade-ags/V14_BACKEND.md
{"full":false,"ignored":["docs/ade-ags/V14_BACKEND.md"],"passed":true,"results":[],"risk":[],"skippedAffected":4,"unmapped":[]}
EXIT_AFFECTED=0
```

Após salvar V15_BACKEND.md, a validação documental final abaixo confirmou os dois caminhos ignored. Sem comandos cargo/vitest/tsc crus; Rust foi chamado somente uma vez na v15.

## Fechamento da coleta e validação final

Releitura de chat.json às 2026-10-12 22:36:28.289 BRT: count=3, newIds=[]. As mesmas três mensagens persistiam; não houve aviso de laço ou envio direto adicional registrado. A janela de observação documentada termina nesse snapshot; mensagens posteriores não entram na contagem.

Comandos: ags test affected --dry-run; ags test affected; git diff --check; git status --short; git branch --show-current. Trecho exato de saída (linhas de diagnóstico [spawn] omitidas):

```text
Nada a testar: só arquivos sem efeito em código.
Sem teste (2): docs/ade-ags/V14_BACKEND.md, docs/ade-ags/V15_BACKEND.md
{"commands":[],"full":false,"ignored":["docs/ade-ags/V14_BACKEND.md","docs/ade-ags/V15_BACKEND.md"],"risk":[],"unmapped":[]}
EXIT_DRY_FINAL=0
Nada a testar: só arquivos sem efeito em código.
Sem teste (2): docs/ade-ags/V14_BACKEND.md, docs/ade-ags/V15_BACKEND.md
{"full":false,"ignored":["docs/ade-ags/V14_BACKEND.md","docs/ade-ags/V15_BACKEND.md"],"passed":true,"results":[],"risk":[],"skippedAffected":4,"unmapped":[]}
EXIT_AFFECTED_FINAL=0
?? docs/ade-ags/V15_BACKEND.md
cc/mission-bbe782a6-ec77-4100-8509-5d7ad611

```
