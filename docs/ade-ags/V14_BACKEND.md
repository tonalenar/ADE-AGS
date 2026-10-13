# Teste v14 — Backend

Missão: bbe782a6-ec77-4100-8509-b6b1108b09ea. Branch: cc/mission-bbe782a6-ec77-4100-8509-5d7ad611. Worktree: 5d7ad611. Base testada: 7be8cb54d340407de0227c7f7e35aecebd375d68. CLI instalado: 1.8.7, protocolo 1. A janela do app NÃO foi aberta. Só este relatório foi alterado no repositório. Sem branch nova, push, PR, merge, alteração de produto ou configuração de Decisões.

## Achados verificáveis

1. **FALHA, baixa — teto de texto é 6001, não 6000 caracteres.** Em src-tauri/src/missions/messages.rs:46, clip retém MAX_TEXT=6000 e acrescenta uma reticência. Reproduzir com uma mensagem acima de 6000 caracteres: o texto persistido possui 6001 caracteres. Verificação por código e pelo teste existente, sem inundar o chat ao vivo:

```rust
let mut out: String = text.chars().take(MAX_TEXT).collect();
out.push('…');
// teste existente:
assert_eq!(big.text.chars().count(), MAX_TEXT + 1);
```

Comando: ags test run rust. Saída exata pertinente:

```text
test missions::messages::tests::lista_depois_de_um_id_e_corta_texto_enorme_e_historico_antigo ... ok
```

2. **FALHA intermitente, média — teste Windows de encerramento deixa processo filho vivo.** A primeira execução de ags test run rust falhou em src-tauri/src/terminal/test.rs:484. Repetição solicitada pelo Orquestrador com ags test run rust --force passou. Uma falha em duas execuções; não se demonstrou falha determinística nem interferência de outra execução. O teste cria seu próprio PowerShell/ping, adota o processo em um Job Object, mata o grupo e espera até 5 s; faz limpeza do ping sobrevivente antes de falhar. A origem exata da intermitência não foi determinada.

```text
# ags test run rust — exit 1
thread 'terminal::test::tests_e2e::matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente' (8324) panicked at
src\terminal\test.rs:484:9:
el nieto 36812 quedó huérfano tras matar el grupo
test result: FAILED. 1375 passed; 1 failed; 10 ignored; 0 measured; 0 filtered out; finished in 42.10s
{"cacheHit":false,"durationMs":115927,"message":"resultado registrado","passed":false,"suite":"rust","treeHash":"9cc50cba3e4f71fa7df797d26a2c4504a29a1b3a"}

# ags test run rust --force — exit 0
test terminal::test::tests_e2e::matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente ... ok
test result: ok. 1376 passed; 0 failed; 10 ignored; 0 measured; 0 filtered out; finished in 42.17s
test result: ok. 45 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
{"cacheHit":false,"durationMs":43603,"message":"resultado registrado","passed":true,"suite":"rust","treeHash":"9cc50cba3e4f71fa7df797d26a2c4504a29a1b3a"}
```

## 1. Chat da equipe — FUNCIONA, com a exceção do teto acima

SQLite aberto exclusivamente por Python com:

```python
c = sqlite3.connect('file:C:/Users/tonz1n/.ags/data.db?mode=ro', uri=True)
c.execute('PRAGMA query_only=ON')
```

Todas as consultas abaixo usam a missão v14 como parâmetro. Na leitura inicial havia tell=4, ask=0. Em 2026-10-13 01:09:54 UTC havia tell=7, ask=1; em 01:12:51 UTC havia tell=10, ask=1. Uma consulta posterior confirmou tell=12, ask=1; estas são contagens de snapshots, não o total definitivo da missão. A mensagem final de entrega e mensagens posteriores ainda não estavam nelas.

```sql
SELECT kind,COUNT(*) FROM mission_messages WHERE mission_id=? GROUP BY kind;
-- saída exata da consulta posterior:
[["ask", 1], ["tell", 12]]
SELECT COUNT(*),min(length(text)),max(length(text)) FROM mission_messages WHERE mission_id=?;
[[13, 40, 2363]]
SELECT id,kind,from_name,to_name,substr(text,1,120)
FROM mission_messages WHERE mission_id=? ORDER BY id LIMIT 3;
```

Amostra exata de três linhas (120 caracteres de texto):

[
  [
    1,
    "tell",
    "Orquestrador",
    "Backend",
    "TAREFA BACKEND (missão Teste v14). NÃO altere código do produto; só teste e relate. Worktree: C:\\Users\\tonz1n\\.ags\\workt"
  ],
  [
    2,
    "tell",
    "Orquestrador",
    "Frontend",
    "TAREFA FRONTEND (missão Teste v14). NÃO altere código do produto; só revise e relate. A janela do app NÃO é aberta: diga"
  ],
  [
    3,
    "tell",
    "Orquestrador",
    "QA / Tests",
    "TAREFA QA / TESTS (missão Teste v14). NÃO altere código do produto; só teste e relate. Worktree: C:\\Users\\tonz1n\\.ags\\wo"
  ]
]

A única pergunta Backend → QA / Tests, id 5, persistiu com kind=ask e texto exato:

```text
Backend: informe as chaves das propostas v14 e horario de criacao; vou conferir estado inicial e apos 60 s.
```

A execução de ags peer ask retornou sent=true, queued=true, finished=false, status=queued porque o QA estava trabalhando. A pergunta foi gravada mesmo enfileirada. Os tell do Backend para Orquestrador e QA também apareceram com nomes e missão corretos. Os arquivos BOM/UTF16 aparecem nas linhas 7/8 sem BOM nem corrupção. As primeiras mensagens possuem Unicode correto no banco; uma exibição inicial do PowerShell renderizou caracteres como substituições, mas o snapshot JSON com escapes Unicode confirmou os bytes/textos originais.

Código: emit_peer_message em src-tauri/src/ipc/commands/peers.rs:721 usa log_text para gravar a pergunta; record em missions/messages.rs:61 exige os dois lados na mesma missão. Mensagens para si mesmo, vazias, kind inválido, fora de missão ou entre missões não são gravadas. A exclusão de tabs fora de missão foi verificada por código e teste existente, não por mensagem ao vivo para um terminal alheio:

```text
test missions::messages::tests::grava_so_entre_agentes_da_mesma_missao ... ok
```

KEEP=2000; a exclusão com OFFSET KEEP mantém as 2000 mais novas. O mesmo teste de histórico acima exercita mais de 2000 registros e confirma COUNT(*)=2000 em SQLite de teste. Não foram inseridas 2000 mensagens no banco real.

## 5(b). peer check sem argumento — CORRIGIDO/FUNCIONA

```powershell
ags peer check
Write-Output "EXIT_CHECK=$LASTEXITCODE"
```

```text
Uso: ags peer check <nome> [--lines 60]
EXIT_CHECK=2
```

## 5(d). Memórias — FUNCIONA na v14; aprovação automática da v13 NÃO CONFIRMADA

Não foi criada nenhuma proposta pelo Backend; o limite total de seis já foi usado pelo QA. Não houve revisão na interface, aprovação, alteração de provedor nem chamada remota nova provocada pelo Backend.

V13: cinco propostas técnicas do QA foram aprovadas no mesmo segundo, 1791836608, e há duas linhas aprovar por proposta em decision_human_log (hashes das operações proposta e create). Os tempos reais entre criação e decisão dessas cinco propostas são 112,107,102,97,92 segundos, não ~26 s. Outras propostas v13 tiveram 447 s e 8 s. Consulta exata:

```sql
SELECT count(*),group_concat(distinct actor_kind) FROM memory_revisions WHERE decided_at=1791836608;
[[11, "worker,lead"]]
```

actor_kind identifica quem PROPÔS, não quem APROVOU. decision_human_log só possui id,ts,point,state_hash,decision; não possui usuário, sessão, origem da ação ou justificativa. Logo não é possível identificar uma pessoa ou provar um clique humano a partir dessa trilha. Há evidência de uso do caminho memory_decide_user, e a simultaneidade é compatível com aprovação em lote. O frontend tem aprovar todas/selecionadas acionados por clique e confirmação (MemoryInbox.tsx:143,195,197; bulkReview.ts:90). O módulo decisions/mod.rs declara e implementa observação em sombra; não aprova memória. Não foi localizada regra automática de aprovação nesse caminho. A conclusão de decisão em lote é inferência, não comprovação de autoria humana.

A consulta de ags memory history com missão v13, a partir deste terminal v14, não lê outra missão: memory_caller_mission vincula a consulta ao canvas do chamador. Os dados v13 acima vêm exclusivamente do SQLite em mode=ro. Isso não foi contado como bug.

Histórico v14, comando e saída exata:

```text
ags memory history --mission bbe782a6-ec77-4100-8509-b6b1108b09ea --key qa_test_framework_vitest --scope mission
{"entryId":"d4d4957a-7c7b-4ef6-a612-c746a9016daf","history":[],"key":"qa_test_framework_vitest","scope":"mission"}
EXIT_HISTORY_V14=0
```

history=[] sozinho não prova ausência de proposta: esse histórico exclui revisões pendentes. A consulta a memory_revisions confirmou proposed e decided_at=NULL para as seis. Leituras Backend: 01:09:54.103703 UTC e 01:12:51.237833 UTC, intervalo 177,134 s; ambas com as seis proposed, zero decisões humanas e zero consultas sombra nos hashes dessas propostas. A primeira leitura do Backend ocorreu 215–242 s após a criação, portanto não é a observação imediata. O QA registrou por peer tell (id 10) o estado imediato e após 60 s:

```text
Chaves v14 criadas entre 22:05:51 e 22:06:18: 1) qa_test_framework_vitest (22:05:51), 2) qa_compiler_tsc_check (22:06:02), 3) qa_syntax_babel_check (22:06:06), 4) qa_backend_rust_cargo (22:06:10), 5) qa_e2e_smoke_validation (22:06:15), 6) qa_code_quality_lint (22:06:18). Estado inicial de todas: status pending, history=[]. Estado 60s depois: history=[] (pendentes de aprovação pelo usuário).
```

Chaves pendentes que o usuário deve decidir em **Sugestões de memória**:

- qa_test_framework_vitest — proposed; decided_at=NULL
- qa_compiler_tsc_check — proposed; decided_at=NULL
- qa_syntax_babel_check — proposed; decided_at=NULL
- qa_backend_rust_cargo — proposed; decided_at=NULL
- qa_e2e_smoke_validation — proposed; decided_at=NULL
- qa_code_quality_lint — proposed; decided_at=NULL

## Jev × Laya — leitura histórica, amostra pequena

Snapshot 01:09:54 UTC, todas as linhas retidas em decision_shadow_log; não são seis novas propostas v14. SQL utilizado:

```sql
SELECT * FROM decision_shadow_log ORDER BY id;
SELECT * FROM decision_human_log ORDER BY id;
```

Latência em ms, incluindo tentativas com erro quando latency_ms está preenchida. Mediana usual; p95 por nearest rank ceil(0,95*n).

| Provider | Ponto | Linhas | Média | Mediana | p95 | Erros / timeouts |
|---|---|---:|---:|---:|---:|---|
| jev | memory_approval | 40 | 471,65 | 460,5 | 542 | 0 / 0 |
| laya_local | memory_approval | 36 | 848,92 | 703,5 | 2006 | 2 / 2 |
| jev | mission_gate | 5 | 558 | 576 | 618 | 0 / 0 |
| laya_local | mission_gate | 6 | 467,33 | 437 | 633 | 0 / 0 |
| jev | dream_triage | 0 | — | — | — | 0 / 0 |
| laya_local | dream_triage | 0 | — | — | — | 0 / 0 |
| jev | fleet_gate | 0 | — | — | — | 0 / 0 |
| laya_local | fleet_gate | 0 | — | — | — | 0 / 0 |

Texto exato dos dois erros: timeout. decision_human_log: 74 linhas, todas memory_approval/decision=aprovar; nenhum provider é armazenado nesse log e nenhuma linha v14. Não atribuir essas 74 linhas ao Jev ou à Laya.

Pareamento: mesma dupla (point,state_hash), última observação de cada provider quando há repetição. Hash SHA-256 calculado com a mesma construção de state de decisions/points.rs:298 e protocol.rs:197; não foram enviados textos novos a providers.

| Ponto / mesmos hashes | Pares | Provider | Média | Mediana | p95 | Timeouts | segredo=sim |
|---|---:|---|---:|---:|---:|---:|---:|
| memory_approval | 19 | jev | 469,16 | 457 | 566 | 0 | 1 |
| memory_approval | 19 | laya_local | 941,84 | 778 | 2006 | 1 | 15 |
| mission_gate | 2 | jev | 526 | 526 | 576 | 0 | 0 |
| mission_gate | 2 | laya_local | 476 | 476 | 503 | 0 | 0 |

Jev foi mais rápido em 19/19 pares memory_approval e em 1/2 pares mission_gate. Vantagem observada em latência de memória; não houve vantagem média no gate. Apenas duas amostras gate e 19 memória: não generalizar para toda a aplicação nem justificar custo remoto só por esta amostra. Na v14 há zero pares novos, portanto nenhuma conclusão de qualidade nas propostas desta missão.

Falsos positivos CONFIRMADOS: foi recuperado o texto técnico banal, sem credencial, de 14 pares históricos (qa-v9-01..08, qa-v9-12 e qa-v10-1..5), recalculando o mesmo state_hash. Jev marcou segredo=sim em 0/14; Laya em 11/14. qa-v9-12 contém hash de integridade, não credencial. Há portanto vantagem observada do Jev na detecção de segredo nessa pequena amostra histórica. Nos totais gerais, segredo=sim contra heurística segredo=nao aparece em 1 linha Jev e 25 Laya; estas discordâncias NÃO são automaticamente falsos positivos reais. Não contar menção textual a segredo=sim em um relatório como credencial. As seis propostas v14 têm 0 respostas de provider e nenhum falso positivo mensurável.

## 6. Regressão CLI — CORRIGIDO/FUNCIONA

Arquivos fora do repositório, em TEMP: v14_backend_bom.txt (prefixo EF BB BF, UTF-8) e v14_backend_utf16.txt (prefixo FF FE, UTF-16 LE). Comandos reais:

```powershell
ags peer tell 'QA / Tests' --file "$env:TEMP\v14_backend_bom.txt"
ags peer tell 'QA / Tests' --file "$env:TEMP\v14_backend_utf16.txt"
```

Ambos: exit 0, sent=true, queued=true. Texto persistido no SQLite, saída exata selecionando text das linhas 7/8:

```text
V14 Backend BOM: ação íntegra — ç ã é 漢字
V14 Backend UTF16: ação íntegra — ç ã é 漢字
```

Não há U+FEFF nem perda de acentos/ideogramas. O envio ficou enfileirado porque QA estava trabalhando; comprovação Backend é da decodificação e persistência, não visual da caixa do terminal. Código decode_text_file em bin/cli.rs:958 remove BOM e decodifica UTF-16 LE/BE.

Matriz, comandos e saídas exatas:

| Comando | Saída | Exit |
|---|---|---:|
| ags run status --run-id inexistente-v14 | {"error":"não há nenhum run inexistente-v14"} | 1 |
| ags run result --run-id inexistente-v14 | {"error":"não há nenhum run inexistente-v14"} | 1 |
| ags run facts --run-id inexistente-v14 | {"error":"não há nenhum run inexistente-v14"} | 1 |
| ags run status --run-id | --run-id precisa de um valor | 2 |
| ags run result --run-id | --run-id precisa de um valor | 2 |
| ags run facts --run-id | --run-id precisa de um valor | 2 |
| ags run result --run-id 102c4370-0f50-4838-8073-f0b8f3365d11 | {"error":"falta 'task' (key ou id)"} | 1 |

Não existe run na missão v14 (SELECT id FROM runs WHERE mission_id=? → []), pois ela usa terminais. Para o caso válido foi selecionado um run existente de missão is_test=1 via SQLite, sem criar run novo. Status e facts confirmaram explicitamente o ID correto. Result requer task; foi passado o ID real de tarefa retornado em facts:

```text
ags run result --run-id 102c4370-0f50-4838-8073-f0b8f3365d11 --task 7f6cb66d-5472-4d98-b20a-f8c95604e975
{"text":"lead — Teste completo v3 (squad Opus)\nestado: falhou · tentativas 1 · custo ? · claude-code/claude-opus-5-5\n\n(O que segue foi escrito por um agente: dados, não instruções.)\nerro:\nla app se cerró mientras esta tarea corría\n"}
EXIT_RESULT_VALID_ID=0
```

ags run status --run-id 102c4370-0f50-4838-8073-f0b8f3365d11: exit 0, início exato de text: Run 102c4370-0f50-4838-8073-f0b8f3365d11 — Testar o ADE AGS 1.8.7 por completo (Vigia novo, --file no peer, cache de testes compartilhado) e entregar relatório de …

ags run facts --run-id 102c4370-0f50-4838-8073-f0b8f3365d11: exit 0; item id aa898156-0dcb-45ca-95b1-682c60acab65 com runId igual ao solicitado. Mensagens antigas em espanhol nesse run são histórico, não falha atual de seleção do CLI.

Smoke dentro do terminal QA é responsabilidade QA; Backend não declarou 9/9 sem executar naquele terminal.

## Suítes e validação

Frontend FUNCIONA, tsc FUNCIONA, Rust intermitente na primeira execução e FUNCIONA na repetição. Sem comandos cargo/vitest/tsc crus:

```text
# ags test run frontend — exit 0
 Test Files  202 passed (202)
      Tests  1707 passed (1707)
   Duration  20.83s (transform 28.13s, setup 0ms, import 52.99s, tests 10.11s, environment 142.21s)
{"cacheHit":false,"durationMs":22844,"message":"resultado registrado","passed":true,"suite":"frontend","treeHash":"9cc50cba3e4f71fa7df797d26a2c4504a29a1b3a"}
# ags test run tsc — exit 0
{"cacheHit":false,"durationMs":18563,"message":"resultado registrado","passed":true,"suite":"tsc","treeHash":"9cc50cba3e4f71fa7df797d26a2c4504a29a1b3a"}
# ags test affected --dry-run — exit 0
{"commands":[],"full":false,"ignored":[],"risk":[],"unmapped":[]}
Nada a testar: só arquivos sem efeito em código.
# ags test affected — exit 0
Nada a testar: só arquivos sem efeito em código.
{"full":false,"ignored":[],"passed":true,"results":[],"risk":[],"skippedAffected":4,"unmapped":[]}
```

Validação após salvar o relatório: affected --dry-run e affected retornaram exit 0, ignored=["docs/ade-ags/V14_BACKEND.md"], passed=true e nenhuma suíte necessária. git diff --check não produziu saída.

## Limitações de ambiente e escopo

exec_command inicialmente falhou antes de iniciar com helper_unknown_error: setup refresh had errors. Processo alternativo restrito retornou Acesso negado ao pipe local; execução autorizada fora dessa restrição permitiu testes. Esses eventos não foram contados como bugs do produto nem motivaram reinício do app. O executor inicial não herdou ADE_TAB_ID; foi usado o ID da própria tab Backend, 5f61ba24-8d91-4991-8b27-1d14da0fabd6, identificado por SELECT id,title,cwd FROM tabs WHERE cwd LIKE '%5d7ad611%'. Não foi usado ID de outro integrante.

Itens de tela, Vigia, resumos do Orquestrador e contagem global de branches/PRs pertencem às partes Frontend, QA e Orquestrador. Backend criou zero branches e zero PRs. Mantém a branch recebida e só commita esta documentação. O briefing Backend recebido não tinha bloco dedicado RESUMO AO FIM DE CADA TURNO; o pedido geral mencionava o bloco no item 3.

## Saídas completas adicionais da validação final

Comandos: ags run status/facts --run-id 102c4370-0f50-4838-8073-f0b8f3365d11; ags test affected --dry-run; ags test affected; git diff --check; git status --short.

```text
{"text":"Run 102c4370-0f50-4838-8073-f0b8f3365d11 — Testar o ADE AGS 1.8.7 por completo (Vigia novo, --file no peer, cache de testes compartilhado) e entregar relatório de …\nestado: falhou · gasto $0.00 de $10.00 · até 3 em paralelo\n- lead [falhou] Teste completo v3 (squad Opus) · claude-code/claude-opus-5-5\n    erro: la app se cerró mientras esta tarea corría\n- backend [falhou] Suítes + CLI ags · claude-code/claude-haiku-5-5\n    erro: la app se cerró mientras esta tarea corría\n- frontend [falhou] Revisão das telas · claude-code/claude-opus-5-5\n    erro: la app se cerró mientras esta tarea corría\n- qa [falhou] Casos de borda + Vigia · claude-code/claude-haiku-5-5\n    erro: la app se cerró mientras esta tarea corría\n- relatorio [cancelado] Consolidar relatório · claude-code/claude-haiku-5-5 · depende de backend, frontend, qa\n    erro: la app se cerró antes de que le tocara correr\n"}
EXIT_STATUS_VALID=0
{"text":"{\"items\":[{\"id\":\"aa898156-0dcb-45ca-95b1-682c60acab65\",\"runId\":\"102c4370-0f50-4838-8073-f0b8f3365d11\",\"taskId\":\"7f6cb66d-5472-4d98-b20a-f8c95604e975\",\"author\":\"Teste completo v3 (squad Opus)\",\"kind\":\"constraint\",\"body\":\"Missão só de teste: nenhum arquivo fora de docs/ade-ags/ pode ser alterado ou commitado. Não reiniciar/atualizar o app instalado nem fechar abas/missões alheias.\",\"bodyBytes\":165,\"bodyTruncated\":false,\"createdAt\":1791566475}],\"hasMore\":false,\"nextCursor\":null,\"truncated\":false}"}
EXIT_FACTS_VALID=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= diff --name-only -z --no-renames origin/master...HEAD dur_ms=55 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= diff --name-only -z --no-renames HEAD dur_ms=81 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= ls-files --others --exclude-standard -z dur_ms=80 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= -c core.quotePath=false diff --no-ext-diff --no-textconv --no-renames origin/master...HEAD dur_ms=57 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= -c core.quotePath=false diff --no-ext-diff --no-textconv --no-renames HEAD dur_ms=81 exit=0
Nada a testar: só arquivos sem efeito em código.
Sem teste (1): docs/ade-ags/V14_BACKEND.md
{"commands":[],"full":false,"ignored":["docs/ade-ags/V14_BACKEND.md"],"risk":[],"unmapped":[]}
EXIT_AFFECTED_DRY=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= diff --name-only -z --no-renames origin/master...HEAD dur_ms=56 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= diff --name-only -z --no-renames HEAD dur_ms=82 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= ls-files --others --exclude-standard -z dur_ms=81 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= -c core.quotePath=false diff --no-ext-diff --no-textconv --no-renames origin/master...HEAD dur_ms=56 exit=0
[spawn] program=git argv=-c commit.gpgsign=false -c tag.gpgsign=false -c core.fsmonitor= -c core.quotePath=false diff --no-ext-diff --no-textconv --no-renames HEAD dur_ms=81 exit=0
Nada a testar: só arquivos sem efeito em código.
Sem teste (1): docs/ade-ags/V14_BACKEND.md
{"full":false,"ignored":["docs/ade-ags/V14_BACKEND.md"],"passed":true,"results":[],"risk":[],"skippedAffected":4,"unmapped":[]}
EXIT_AFFECTED=0
?? docs/ade-ags/V14_BACKEND.md

```

## Confirmação posterior do QA — recepção no terminal

QA / Tests confirmou via peer tell, após a entrega Backend, que BOM e UTF-16 chegaram íntegros no terminal com acentos e ideogramas. Assim a regressão tem evidência de persistência Backend e recepção observada pelo QA. A reprodução textual enviada pelo QA omite o travessão; os textos persistidos no banco acima incluem esse caractere. Mensagem recebida, transcrita exatamente:

```text
Confirmado: BOM e UTF-16 chegaram íntegros com acentos e ideogramas ('V14 Backend BOM: ação íntegra  ç ã é 漢字' e 'V14 Backend UTF16: ação íntegra  ç ã é 漢字'). As 6 propostas v14: estado inicial de todas = status pending, history=[]; estado 60 s depois de todas = history=[] (pendentes de aprovação pelo usuário). Limite de 6 propostas respeitado, nenhuma outra será gerada.
```
