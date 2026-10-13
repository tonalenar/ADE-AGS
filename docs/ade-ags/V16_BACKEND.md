# V16 Backend — correções do Vigia

Missão bbe782a6-ec77-4100-8509-b6b1108b09ea. Branch cc/mission-bbe782a6-ec77-4100-8509-5d7ad611. Integração inicial autorizada: git merge cc/mission-bbe782a6-ec77-4100-8509-cb6b7b23, fast-forward 87e04d0b → 22842dac (somente relatórios V14/V15). Sem branch nova, push, PR ou merge externo.

## Estado da entrega

G2, G5 e G6 implementados. As duas rodadas iniciais e a escalada estão preservadas abaixo como histórico. O usuário autorizou explicitamente uma rodada manual limitada ao teste: avançar vi.setSystemTime por VIGIA_COOLDOWN_MS+1. Somente essas duas linhas foram acrescentadas ao teste; nenhum código de produto foi alterado depois do candidato f795e7fd. Validação manual final CONCLUÍDA: affected, frontend completo, tsc e Rust completos verdes, todos exit 0. G2, G5 e G6 CORRIGIDOS no código e nos testes. Sem pendência de teste ou bloqueio.

## G2 — aviso no feed da missão

CORRIGIDO no código e teste Rust. record e record_vigia compartilham record_inner e os mesmos limites/INSERT/retention existentes; nenhuma coluna, tabela, migração ou SQL de schema foi alterado. O caminho de peer normal continua recusando mensagem para si mesmo, inclusive com nome Vigia. Só o helper interno de aviso permite usar a mesma tab do Orquestrador nos dois lados.

Contrato comunicado ao Frontend:

- kind=tell.
- from_name=Vigia; from_tab_id=ID da tab do Orquestrador.
- to_name=nome real do Orquestrador; to_tab_id=mesma tab.
- mission_id derivado do canvas, como no record existente.
- text completo do aviso; at_ms em milissegundos.

Não se inventa tab/destinatário integrante. vigia_report mantém uma gravação no chat do agente e acrescenta uma no feed da missão; nenhuma duplicação adicional no chat. O frontend lê por polling existente; não se emite cc-peer-message para um aviso e não se altera tracking de tarefas por esse canal. Avisos fora de missão não entram em mission_messages. Frontend confirmou que ajustou a renderização para ocultar “→ destino” quando os dois IDs coincidem.

Teste novo: missions::messages::tests::vigia_vai_uma_vez_ao_feed_da_missao_sem_liberar_peer_para_si_mesmo. Verifica nomes, kind, tab IDs, texto, registro único por chamada, isolamento de missão, não grava fora de missão e não libera self no caminho peer. Usa SQLite em memória, jamais ~/.ags/data.db.

## G5 — entrega final e resposta assíncrona

CORRIGIDO no código e validação final: testes de status, pergunta, entrega durante consulta e reativação após nova tarefa/cooldown passam. sentAt continua registrando atividade/resposta a poke. Novo finishedAt, persistido no mesmo objeto localStorage ags.vigia.peers.v1, guarda só declaração de entrega final explícita. Dados antigos sem finished são carregados sem converter atividade antiga em entrega.

isFinalReport exige kind=tell e declaração no começo da primeira linha, aceitando prefixo do nome real do agente e vN. Marcadores: ENTREGUE, Entrega final, trabalho concluído, encerrado/finalizado/concluído ou terminei. Pergunta, status, negação, conclusão de um teste intermediário e texto que apenas explica o marcador não encerram a tarefa. Nomes com caracteres especiais são escapados. O contrato da mensagem final foi comunicado ao Frontend.

watchdogFinding e idleCandidates recebem finishedAt, não sentAt. O callback de vigia_check revalida memberFinished e horário atual antes de enfileirar poke. Entrega final não abre tarefa no destinatário. Uma tarefa posterior à entrega usa timestamp novo e pode voltar a ser observada depois do cooldown normal.

Testes novos/refinados:

- Status/pergunta/“entregue?”/“ainda não entregue”/“teste concluído” não encerram.
- Texto explicando “use ENTREGUE” não encerra.
- Entrega real, prefixo QA / Tests v16 e nome com colchetes são reconhecidos.
- Entrega anterior à nova tarefa não encerra a tarefa nova.
- Teste integrado verifica status ainda observado, entrega final removida de idle e timestamp do destinatário preservado.
- Teste integrado resolve consulta após entrega final e confirma zero poke.

A falha da segunda rodada estava na extensão do teste integrado que esperava vigia_check imediatamente após nova tarefa, ainda dentro de VIGIA_COOLDOWN_MS. A rodada manual autorizada ajustou o relógio do teste; a implementação não foi alterada para ignorar esse cooldown legítimo.

## G6 — confirmação real de envio e erro visível

CORRIGIDO no código e nos testes específicos. O Vigia usa SendTimings.onSent já existente em sendWhenReady. “mandei a ...” e “lembrete N/3 enviado” são registrados somente nesse callback, não ao enfileirar. O contador do watchdog também só incrementa após onSent. A fila é marcada como pendente antes para evitar repetição de poke; o horário é atualizado no envio confirmado. terminalRegistry.ts não foi editado, respeitando o limite de arquivos.

Falha de invoke(vigia_report) agora gera console.error com prefixo [Vigia] e erro original. Não há retry automático que duplique mensagem de chat.

Testes novos integrados: fila sem callback não registra envio; onSent passa a registrar; watchdog só conta após onSent; rejeição de vigia_report aparece no console. O recibo onSent confirma a colagem/submissão pelo mecanismo existente do terminal, não uma resposta posterior do agente.

## Arquivos tocados nesta entrega

- src-tauri/src/missions/messages.rs
- src-tauri/src/missions/vigia.rs
- src/features/missions/vigia.ts
- src/features/missions/vigiaPoke.ts
- src/features/missions/tests/vigiaPoke.test.ts
- src/features/missions/tests/vigiaDelivery.test.ts (novo)
- docs/ade-ags/V16_BACKEND.md (este relatório)

Não houve edição de schema, instalador, CI, permissões, segurança, versões, Contas, chaves ou Ajustes > Decisões. Não houve consulta mutante ou escrita direta no banco real. A janela do app não foi aberta, fechada ou reiniciada. O app instalado permanece na versão original: mudanças verificadas em código/testes, sem alegar teste visual/runtime do executável novo.

## Histórico das duas rodadas iniciais — comandos e saídas exatas pertinentes

ags test affected foi usado a cada passo, sem cargo/vitest/tsc crus. Diagnósticos [spawn] e nomes de testes não relacionados foram omitidos nos trechos abaixo. G2: exit 0 (138 testes Rust relacionados); G5 inicial: exit 0 (102 testes frontend relacionados); G6 e refinamento de declaração: exit 0 (107 relacionados).

### v16_backend_g2.txt

Comando: ags test affected.

```text
test missions::messages::tests::vigia_vai_uma_vez_ao_feed_da_missao_sem_liberar_peer_para_si_mesmo ... ok
test result: ok. 138 passed; 0 failed; 0 ignored; 0 measured; 1249 filtered out; finished in 11.33s
{"full":false,"ignored":["docs/ade-ags/RELATORIO_TESTE_V14.md","docs/ade-ags/RELATORIO_TESTE_V15.md","docs/ade-ags/V14_BACKEND.md","docs/ade-ags/V14_FRONTEND.md","docs/ade-ags/V14_QA.md","docs/ade-ags/V15_BACKEND.md","docs/ade-ags/V15_FRONTEND.md","docs/ade-ags/V15_QA.md"],"passed":true,"results":[{"cacheHit":false,"durationMs":41568,"message":"resultado registrado","passed":true,"suite":"rust","treeHash":"1e04d2a6eb2a24ebb4d627676657a9267df860a3"}],"risk":[],"skippedAffected":3,"unmapped":[]}
```

### v16_backend_g5.txt

Comando: ags test affected.

```text
 Test Files  9 passed (9)
      Tests  102 passed (102)
{"full":false,"ignored":["docs/ade-ags/RELATORIO_TESTE_V14.md","docs/ade-ags/RELATORIO_TESTE_V15.md","docs/ade-ags/V14_BACKEND.md","docs/ade-ags/V14_FRONTEND.md","docs/ade-ags/V14_QA.md","docs/ade-ags/V15_BACKEND.md","docs/ade-ags/V15_FRONTEND.md","docs/ade-ags/V15_QA.md"],"passed":true,"results":[{"cacheHit":false,"durationMs":1096,"message":"resultado registrado","passed":true,"suite":"babel","treeHash":"30b024c4bb64b828448094df9951e2a60dc0cb1a"},{"cacheHit":false,"durationMs":17102,"message":"resultado registrado","passed":true,"suite":"tsc","treeHash":"30b024c4bb64b828448094df9951e2a60dc0cb1a"},{"cacheHit":false,"durationMs":4513,"message":"resultado registrado","passed":true,"suite":"frontend","treeHash":"30b024c4bb64b828448094df9951e2a60dc0cb1a"},{"cacheHit":true,"durationMs":0,"message":"já verde neste hash (há 0 min)","passed":true,"suite":"rust","treeHash":"30b024c4bb64b828448094df9951e2a60dc0cb1a"}],"risk":[],"skippedAffected":0,"unmapped":[]}
```

### v16_backend_g6.txt

Comando: ags test affected.

```text
 Test Files  10 passed (10)
      Tests  107 passed (107)
{"full":false,"ignored":["docs/ade-ags/RELATORIO_TESTE_V14.md","docs/ade-ags/RELATORIO_TESTE_V15.md","docs/ade-ags/V14_BACKEND.md","docs/ade-ags/V14_FRONTEND.md","docs/ade-ags/V14_QA.md","docs/ade-ags/V15_BACKEND.md","docs/ade-ags/V15_FRONTEND.md","docs/ade-ags/V15_QA.md"],"passed":true,"results":[{"cacheHit":false,"durationMs":1097,"message":"resultado registrado","passed":true,"suite":"babel","treeHash":"1737e46388eef0fc28940dbb9acffd53f5bc469d"},{"cacheHit":false,"durationMs":14042,"message":"resultado registrado","passed":true,"suite":"tsc","treeHash":"1737e46388eef0fc28940dbb9acffd53f5bc469d"},{"cacheHit":false,"durationMs":4574,"message":"resultado registrado","passed":true,"suite":"frontend","treeHash":"1737e46388eef0fc28940dbb9acffd53f5bc469d"},{"cacheHit":true,"durationMs":0,"message":"já verde neste hash (há 3 min)","passed":true,"suite":"rust","treeHash":"1737e46388eef0fc28940dbb9acffd53f5bc469d"}],"risk":[],"skippedAffected":0,"unmapped":[]}
```

### v16_backend_boundary.txt

Comando: ags test affected.

```text
 Test Files  10 passed (10)
      Tests  107 passed (107)
{"full":false,"ignored":["docs/ade-ags/RELATORIO_TESTE_V14.md","docs/ade-ags/RELATORIO_TESTE_V15.md","docs/ade-ags/V14_BACKEND.md","docs/ade-ags/V14_FRONTEND.md","docs/ade-ags/V14_QA.md","docs/ade-ags/V15_BACKEND.md","docs/ade-ags/V15_FRONTEND.md","docs/ade-ags/V15_QA.md"],"passed":true,"results":[{"cacheHit":false,"durationMs":1021,"message":"resultado registrado","passed":true,"suite":"babel","treeHash":"fc638931710242b8a811460bcc75c71ce171ec34"},{"cacheHit":false,"durationMs":15002,"message":"resultado registrado","passed":true,"suite":"tsc","treeHash":"fc638931710242b8a811460bcc75c71ce171ec34"},{"cacheHit":false,"durationMs":4744,"message":"resultado registrado","passed":true,"suite":"frontend","treeHash":"fc638931710242b8a811460bcc75c71ce171ec34"},{"cacheHit":true,"durationMs":0,"message":"já verde neste hash (há 5 min)","passed":true,"suite":"rust","treeHash":"fc638931710242b8a811460bcc75c71ce171ec34"}],"risk":[],"skippedAffected":0,"unmapped":[]}
```

### v16_backend_affected_final.txt

Comando: ags test affected.

```text
AssertionError: expected 1000000 to be undefined
 Test Files  1 failed | 9 passed (10)
      Tests  1 failed | 106 passed (107)
{"full":false,"ignored":["docs/ade-ags/RELATORIO_TESTE_V14.md","docs/ade-ags/RELATORIO_TESTE_V15.md","docs/ade-ags/V14_BACKEND.md","docs/ade-ags/V14_FRONTEND.md","docs/ade-ags/V14_QA.md","docs/ade-ags/V15_BACKEND.md","docs/ade-ags/V15_FRONTEND.md","docs/ade-ags/V15_QA.md"],"passed":false,"results":[{"cacheHit":false,"durationMs":1121,"message":"resultado registrado","passed":true,"suite":"babel","treeHash":"81ced5d8bfb997c0700960e1c2604663527757b8"},{"cacheHit":false,"durationMs":15146,"message":"resultado registrado","passed":true,"suite":"tsc","treeHash":"81ced5d8bfb997c0700960e1c2604663527757b8"},{"cacheHit":false,"durationMs":4857,"message":"resultado registrado","passed":false,"suite":"frontend","treeHash":"81ced5d8bfb997c0700960e1c2604663527757b8"},{"cacheHit":true,"durationMs":0,"message":"já verde neste hash (há 7 min)","passed":true,"suite":"rust","treeHash":"81ced5d8bfb997c0700960e1c2604663527757b8"}],"risk":[],"skippedAffected":0,"unmapped":[]}
```

### v16_backend_frontend.txt

Comando: ags test run frontend --force.

```text
AssertionError: expected 1000000 to be undefined
 Test Files  1 failed | 202 passed (203)
      Tests  1 failed | 1713 passed (1714)
{"cacheHit":false,"durationMs":12623,"message":"resultado registrado","passed":false,"suite":"frontend","treeHash":"81ced5d8bfb997c0700960e1c2604663527757b8"}
```

### v16_backend_tsc.txt

Comando: ags test run tsc --force.

```text
{"cacheHit":false,"durationMs":15120,"message":"resultado registrado","passed":true,"suite":"tsc","treeHash":"81ced5d8bfb997c0700960e1c2604663527757b8"}
```

### v16_backend_rust.txt

Comando: ags test run rust --force.

```text
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1386 filtered out; finished in 0.08s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1386 filtered out; finished in 0.10s
test missions::messages::tests::vigia_vai_uma_vez_ao_feed_da_missao_sem_liberar_peer_para_si_mesmo ... ok
test result: ok. 1377 passed; 0 failed; 10 ignored; 0 measured; 0 filtered out; finished in 44.68s
test result: ok. 45 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
{"cacheHit":false,"durationMs":73628,"message":"árvore suja ou alterada durante o teste: sem reutilização de cache","passed":true,"suite":"rust","treeHash":"81ced5d8bfb997c0700960e1c2604663527757b8"}
```

### v16_backend_affected_round2.txt

Comando: ags test affected.

```text
AssertionError: expected "vi.fn()" to be called with arguments: [ 'vigia_check', ObjectContaining{…} ]
Number of calls: 0
 Test Files  1 failed | 9 passed (10)
      Tests  1 failed | 106 passed (107)
{"full":false,"ignored":["docs/ade-ags/RELATORIO_TESTE_V14.md","docs/ade-ags/RELATORIO_TESTE_V15.md","docs/ade-ags/V14_BACKEND.md","docs/ade-ags/V14_FRONTEND.md","docs/ade-ags/V14_QA.md","docs/ade-ags/V15_BACKEND.md","docs/ade-ags/V15_FRONTEND.md","docs/ade-ags/V15_QA.md"],"passed":false,"results":[{"cacheHit":false,"durationMs":4244,"message":"resultado registrado","passed":true,"suite":"babel","treeHash":"635f8303b44a7784c183515f866da6b9232b441f"},{"cacheHit":false,"durationMs":19382,"message":"resultado registrado","passed":true,"suite":"tsc","treeHash":"635f8303b44a7784c183515f866da6b9232b441f"},{"cacheHit":false,"durationMs":4829,"message":"resultado registrado","passed":false,"suite":"frontend","treeHash":"635f8303b44a7784c183515f866da6b9232b441f"},{"cacheHit":true,"durationMs":0,"message":"já verde neste hash (há 8 min)","passed":true,"suite":"rust","treeHash":"635f8303b44a7784c183515f866da6b9232b441f"}],"risk":[],"skippedAffected":0,"unmapped":[]}
```

### v16_backend_frontend_round2.txt

Comando: ags test run frontend --force.

```text
AssertionError: expected "vi.fn()" to be called with arguments: [ 'vigia_check', ObjectContaining{…} ]
Number of calls: 0
 Test Files  1 failed | 202 passed (203)
      Tests  1 failed | 1713 passed (1714)
{"cacheHit":false,"durationMs":13099,"message":"resultado registrado","passed":false,"suite":"frontend","treeHash":"635f8303b44a7784c183515f866da6b9232b441f"}
```

### v16_backend_tsc_round2.txt

Comando: ags test run tsc --force.

```text
{"cacheHit":false,"durationMs":14765,"message":"resultado registrado","passed":true,"suite":"tsc","treeHash":"635f8303b44a7784c183515f866da6b9232b441f"}
```

### v16_backend_rust_round2.txt

Comando: ags test run rust --force.

```text
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1386 filtered out; finished in 0.10s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1386 filtered out; finished in 0.14s
test missions::messages::tests::vigia_vai_uma_vez_ao_feed_da_missao_sem_liberar_peer_para_si_mesmo ... ok
test result: ok. 1377 passed; 0 failed; 10 ignored; 0 measured; 0 filtered out; finished in 41.86s
test result: ok. 45 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
{"cacheHit":false,"durationMs":43000,"message":"resultado registrado","passed":true,"suite":"rust","treeHash":"635f8303b44a7784c183515f866da6b9232b441f"}
```

Rodada 1: frontend 1713 passaram/1 falhou; tsc exit 0; Rust 1377 passaram/10 ignorados + CLI 45/45, exit 0. Expectativa incorreta: task.lead deveria ser undefined, mas um status anterior já tinha criado timestamp. Ajustado apenas o teste para comparar com o timestamp anterior.

Rodada 2: frontend 1713 passaram/1 falhou; tsc exit 0; Rust verde, incluindo teste novo G2 e teste intermitente antigo. Expectativa restante: nova consulta imediata, apesar do cooldown 4 min. Correção sugerida ao Orquestrador: no teste, vi.setSystemTime(Date.now()+VIGIA_COOLDOWN_MS+1) antes de esperar nova consulta. Sem mudar comportamento de produto ou remover a asserção.

A árvore mudou apenas no teste frontend durante a execução Rust da rodada 1; o CLI registrou “árvore suja ou alterada durante o teste: sem reutilização de cache”. A suíte Rust da rodada 2 foi executada de novo com --force na árvore estável. Não foi usado o verde antigo para fechar a entrega.

## Rodada manual autorizada — entrega final verde

O Orquestrador comunicou autorização explícita do usuário para UMA rodada manual só de teste. O ajuste foi limitado a duas linhas em vigiaDelivery.test.ts: importar VIGIA_COOLDOWN_MS e chamar vi.setSystemTime(Date.now()+VIGIA_COOLDOWN_MS+1) antes da expectativa de consulta de uma nova tarefa. A asserção não foi removida e nenhum comportamento do produto foi alterado depois do candidato f795e7fd. git diff contra o candidato, excluindo esse teste e documentação, não mostrou arquivos de produto modificados.

As falhas das duas rodadas anteriores acima são histórico resolvido; não são falhas abertas na entrega final. Os comandos abaixo foram executados uma vez nesta rodada manual. --force nas suítes completas garante execução real, inclusive do teste intermitente de encerramento de processos.

### ags test affected — exit 0

```text
 Test Files  10 passed (10)
      Tests  107 passed (107)
{"full":false,"ignored":["docs/ade-ags/RELATORIO_TESTE_V14.md","docs/ade-ags/RELATORIO_TESTE_V15.md","docs/ade-ags/V14_BACKEND.md","docs/ade-ags/V14_FRONTEND.md","docs/ade-ags/V14_QA.md","docs/ade-ags/V15_BACKEND.md","docs/ade-ags/V15_FRONTEND.md","docs/ade-ags/V15_QA.md","docs/ade-ags/V16_BACKEND.md"],"passed":true,"results":[{"cacheHit":false,"durationMs":1050,"message":"resultado registrado","passed":true,"suite":"babel","treeHash":"884fffc430f767dba30a0585a5fdb3fb6bbba27a"},{"cacheHit":false,"durationMs":14564,"message":"resultado registrado","passed":true,"suite":"tsc","treeHash":"884fffc430f767dba30a0585a5fdb3fb6bbba27a"},{"cacheHit":false,"durationMs":4804,"message":"resultado registrado","passed":true,"suite":"frontend","treeHash":"884fffc430f767dba30a0585a5fdb3fb6bbba27a"},{"cacheHit":true,"durationMs":0,"message":"já verde neste hash (há 15 min)","passed":true,"suite":"rust","treeHash":"884fffc430f767dba30a0585a5fdb3fb6bbba27a"}],"risk":[],"skippedAffected":0,"unmapped":[]}
```

### ags test run frontend --force — exit 0

```text
 Test Files  203 passed (203)
      Tests  1714 passed (1714)
{"cacheHit":false,"durationMs":12610,"message":"resultado registrado","passed":true,"suite":"frontend","treeHash":"884fffc430f767dba30a0585a5fdb3fb6bbba27a"}
```

### ags test run tsc --force — exit 0

```text
{"cacheHit":false,"durationMs":14901,"message":"resultado registrado","passed":true,"suite":"tsc","treeHash":"884fffc430f767dba30a0585a5fdb3fb6bbba27a"}
```

### ags test run rust --force — exit 0

```text
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1386 filtered out; finished in 0.06s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1386 filtered out; finished in 0.10s
test missions::messages::tests::vigia_vai_uma_vez_ao_feed_da_missao_sem_liberar_peer_para_si_mesmo ... ok
test terminal::test::tests_e2e::matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente ... ok
test result: ok. 1377 passed; 0 failed; 10 ignored; 0 measured; 0 filtered out; finished in 42.53s
test result: ok. 45 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
{"cacheHit":false,"durationMs":121674,"message":"resultado registrado","passed":true,"suite":"rust","treeHash":"884fffc430f767dba30a0585a5fdb3fb6bbba27a"}
```

Resumo final: affected 107/107 relacionados; frontend 203 arquivos e 1714/1714 testes; tsc exit 0; Rust 1377 passaram/0 falhas/10 ignorados e CLI 45/45. O teste G2 e o teste intermitente antigo passaram. TreeHash validado: 884fffc430f767dba30a0585a5fdb3fb6bbba27a. git diff --check sem saída. Nenhuma suíte adicional foi repetida depois desse verde.
