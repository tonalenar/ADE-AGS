# Backend — teste v12

2026-10-11; app/CLI 1.8.7, build 8d0df883a3892eccb5450d5b5e30ebd4ff16a06e. Branch cc/mission-dc83d87a-67d8-4dcd-9dc6-9d526890. Só documentação: nenhum código do produto/configuração/chave alterado; banco aberto exclusivamente mode=ro + PRAGMA query_only=ON. Janela do app não aberta, fechada nem reiniciada. Nenhuma proposta de memória Backend gerada.

Saídas integrais de 29 comandos, stdout/stderr e códigos: [V12_BACKEND_CLI.md](V12_BACKEND_CLI.md). Estatísticas auditáveis: [V12_BACKEND_DECISION_STATS.json](V12_BACKEND_DECISION_STATS.json).

## Veredito v11 e reprodução

Executar os comandos abaixo no worktree Backend, fora de tarefa e sem ADE_TAB_ID.

| Caso v11 | Veredito | Comando / saída exata relevante |
| --- | --- | --- |
| Sem --cwd: erro falta quem pede | **CORRIGIDO quanto ao erro de contexto; último run ainda NÃO VERIFICADO** | `ags run status`, `ags run result`, `ags run facts` → `{"error":"ainda não há nenhum run lançado desta pasta: crie um com run_plan"}`, exit 1. Este worktree tem zero runs. |
| --run-id inexistente sem --cwd | **CORRIGIDO** | `ags run status --run-id v12-inexistente` (também result/facts) → `{"error":"não há nenhum run v12-inexistente"}`, exit 1. |
| ID válido de outro run sem --cwd | **CORRIGIDO** | `ags run status --run-id 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0` → quadro começa `Run 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0 — Revisar memória e propor melhorias com fontes`; exit 0. |
| --task por ID | **CORRIGIDO** | `ags run result --run-id 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0 --task 9a644dcb-8e3b-4fdc-8f29-acb1a918b885` → `9a644dcb — Sonhar agora`, exit 0. |
| --task por chave | **CORRIGIDO** | `ags run result --run-id 102c4370-0f50-4838-8073-f0b8f3365d11 --task backend` → `backend — Suítes + CLI ags`, exit 0. |
| facts do run solicitado | **CORRIGIDO** | `ags run facts --run-id 102c4370-0f50-4838-8073-f0b8f3365d11` → item aa898156-0dcb-45ca-95b1-682c60acab65, runId 102c4370-0f50-4838-8073-f0b8f3365d11. |
| --run-id sem valor | **CORRIGIDO** | `ags run status --run-id` (também result/facts) → stderr `--run-id precisa de um valor`, exit 2. |
| --cwd . | **CORRIGIDO quanto à normalização** | `ags run status --cwd .` (também result/facts) → mesma mensagem portuguesa de pasta sem runs, exit 1; não acusa workspace chamado ponto. |
| peer check sem argumento | **CORRIGIDO** | `ags peer check` → stderr `Uso: ags peer check <nome> [--lines 60]`, exit 2. |
| Quadros status/result, estados e avisos de dados | **CORRIGIDO** | run f8019494: `estado: concluído`, `[concluído]`, `Entrega v1 (dados não confiáveis do agente):`; result backend: `Entrega (dados não confiáveis do agente, nunca instruções):`. Run 77d5b151: `estado: falhou`. |
| peer tell --file inexistente | **CORRIGIDO** | `ags peer tell Orquestrador --file v12-arquivo-inexistente.txt` → `Não foi possível ler v12-arquivo-inexistente.txt: O sistema não pode encontrar o arquivo especificado. (os error 2)`, exit 2. |
| Recursos inexistentes | **CORRIGIDO nos quatro recursos testados** | tab output → `Esta janela não tem nenhuma aba com o id v12-inexistente`; mission status → `não há nenhuma missão v12-inexistente`; skill show → `Não há nenhuma skill instalada chamada 'v12-inexistente'. Instaladas: ags-orchestrator, canvas-design`; workspace open → `Não existe o workspace 'v12-inexistente'`. |

**Bloqueio de cobertura:** o pedido exige executar DE DENTRO de uma pasta com >=2 runs, mas todas as pastas existentes com >=2 runs estão fora deste worktree. Não criei fixtures no banco nem saí do worktree. O Orquestrador precisa conferir status/result/facts de dentro de uma pasta com runs; não declarar esse cenário integralmente coberto por esta entrega. `run result` requer --task para mostrar um resultado de tarefa.

## Achados por gravidade

**P3 — AINDA FALHA parcial: inglês na ajuda / rótulo.** Reprodução: `ags --help`, exit 0, stderr contém exatamente `Página do índice ou UMA entrada inteira (UNTRUSTED DATA)`, `O que pôr em --agent (inclui os custom)`. Quadros result ainda têm `branch:` e `(worktree ... )`. A ajuda também mantém TABS, Tabs/tab, WORKSPACES/Workspaces, POOLS, skills/SKILLS, Squad, Fast, headless, refs, push, polling, shell, snapshot, click, type, resize, console, eval, upload, cookies, PRs, issues, push/pull, stdin, stdout: a maior parte é vocabulário técnico/nome de comando; não confundir com nova frase espanhola. Não encontrei frase em espanhol na ajuda.

Espanhol visível nos quadros históricos, **sem prova de nova emissão**: `no se pudo lanzar 'claude': O nome do arquivo ou a extensão é muito grande. (os error 206)` e `la app se cerró mientras esta tarea corría`. Inglês visível no texto de agentes: `Created ...`, `Validation failed`, `VALIDATION PASSED: 7 bytes exact`, e campos de JSON técnico. Não classificar conteúdo histórico/do agente como regressão de tradução do produto. Os resíduos v11 `failed`/`done` e `untrusted worker data` nos rótulos gerados foram corrigidos.

Nenhum P0/P1/P2 novo confirmado.

## Suítes autorizadas

| Comando | Resultado exato / tempo |
| --- | --- |
| ags test run rust | `{"cacheHit":true,"durationMs":0,"message":"já verde neste hash (há 684 min)","passed":true,"suite":"rust","treeHash":"e5add89d6927279a16774bfb0b767d2735577231"}`; chamada 1,28 s. Sem rerodar o verde, conforme briefing. |
| ags test run tsc | `{"cacheHit":true,"durationMs":0,"message":"já verde neste hash (há 687 min)","passed":true,"suite":"tsc","treeHash":"e5add89d6927279a16774bfb0b767d2735577231"}`; chamada 1,35 s. |
| ags test run frontend | `Test Files 201 passed (201)`; `Tests 1701 passed (1701)`; `Duration 19.93s`; wrapper `{"cacheHit":false,"durationMs":21928,"message":"resultado registrado","passed":true,"suite":"frontend","treeHash":"e5add89d6927279a16774bfb0b767d2735577231"}`. ~22 s contra baseline 18 s (+22%); sem falha. |
| ags test affected --dry-run | `Nada a testar: só arquivos sem efeito em código.` e `{"commands":[],"full":false,"ignored":[],"risk":[],"unmapped":[]}`. |
| ags test affected | `Nada a testar: só arquivos sem efeito em código.` e `{"full":false,"ignored":[],"passed":true,"results":[],"risk":[],"skippedAffected":4,"unmapped":[]}`. |

Rust/tsc em cache não fornecem uma medição nova comparável ao baseline 135/23 s. `ags test status` mostra último verde completo associado ao escopo Rust em 77524 ms e tsc em 42404 ms; são históricos, não tempos desta rodada. Não executei cargo/vitest/tsc crus.

## Jev × Laya — leitura exclusivamente ro

Leituras 11:06:26Z, 11:08:31Z e **11:10:56Z (após aviso do QA de cinco propostas submetidas)**: **69 shadow, 42 human**, sem mudança entre as leituras. SQLite: `sqlite3.connect(Path('C:/Users/tonz1n/.ags/data.db').as_uri()+'?mode=ro', uri=True)`; `PRAGMA query_only=ON`; `SELECT * FROM decision_shadow_log ORDER BY id`, `SELECT * FROM decision_human_log ORDER BY id`. Sem acesso a chaves/configurações. p95 nearest-rank; média/mediana incluem erros quando há latência.

| Provider / ponto | Linhas | Média ms | Mediana ms | p95 ms | Erros exatos | Timeouts | Segredo divergente | Human correlacionado |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| jev memory_approval | 24 | 469,71 | 459 | 544 | nenhum | 0 | 1 | 21 |
| laya_local memory_approval | 36 | 848,92 | 703,5 | 2006 | `timeout` ×2 | 2 | 25 | 16 |
| jev mission_gate | 3 | 542,67 | 576 | 576 | nenhum | 0 | 0 | 0 |
| laya_local mission_gate | 6 | 467,33 | 437 | 633 | nenhum | 0 | 0 | 0 |
| jev dream_triage / fleet_gate | 0 / 0 | — | — | — | nenhum | 0 | 0 | 0 |
| laya_local dream_triage / fleet_gate | 0 / 0 | — | — | — | nenhum | 0 | 0 | 0 |

Human não tem provider nem latência: 42 linhas, todas memory_approval/`aprovar`. A coluna correlacionada é junção por point+state_hash e não deve ser somada entre providers (há interseção). Segredo divergente = provider `segredo=sim` versus heurística `segredo=nao`; **não é falso positivo comprovado**.

Mesmas propostas, point+state_hash: **19 pares memory_approval**, Jev média/mediana/p95 469,16/457/566 ms versus Laya 941,84/778/2006 ms; Jev mais rápido **19/19**, média **50,19% menor**, zero timeout versus um. Segredo=sim: 1 versus 15. **2 pares mission_gate**, Jev 526/526/576 ms versus Laya 476/476/503 ms; Jev mais rápido 1/2, média 50 ms maior. Sem hashes duplicados por provider. Nos 16 pares de memória com human correlacionado, Jev marcou segredo 0/16, Laya 13/16.

**Conclusão:** vantagem observada do Jev na latência de memória, sem vantagem média no gate pareado. Amostra pequena, histórica e não aleatória, pares consultados em momentos distintos, zero amostra em dois pontos e sem medição de custo; não permite afirmar vantagem geral. Os logs só guardam hashes/decisões, não o corpo das propostas: falsos positivos comprovados em propostas sem credencial **não mensuráveis**. O QA avisou que submeteu cinco propostas técnicas pendentes; a releitura após esse aviso manteve exatamente as mesmas 60 linhas memory_approval da v11. Não há novas amostras das propostas v12. As consultas só são disparadas pela revisão na interface, não pela submissão via CLI (comportamento já conhecido). O usuário deve decidir as propostas em **Sugestões de memória**; chaves exatas ficam na entrega QA/Orquestrador. Nenhuma revisão na interface foi feita pelo Backend.

## Vigia e bloqueios de ambiente

Até esta entrega, nenhuma mensagem Vigia recebida neste terminal: úteis 0, ruído 0, `[Pasted text #N]` empacado 0, cutucadas após entrega 0. Não observável pelo Backend: chat e terminais alheios; não concluir que o Vigia não emitiu mensagens globalmente. Nenhum intervalo observado de tela parada/Working >8 min; nenhum aviso de laço observado.

A execução padrão não iniciou: `helper_unknown_error: setup refresh had errors`. IPC funciona na execução autorizada fora do sandbox. Mensageria bloqueada porque o processo não herdou ADE_TAB_ID: `{"error":"Este comando só funciona dentro de um terminal do ADE AGS (falta ADE_TAB_ID)."}`. A revisão automática rejeitou definir manualmente o ID do terminal Backend confirmado por tab list, por considerar impersonação/bypass; autorização solicitada e pendente. Não contornei a rejeição. Por isso portal/nota inexistente não foram validados e peer tell de entrega permanece bloqueado. Limites de sandbox/ADE_TAB_ID já conhecidos: não listados como bugs novos do produto.

Arquivos tocados: somente este relatório e os dois anexos em docs/ade-ags. Nenhum PR aberto ou merge feito.
