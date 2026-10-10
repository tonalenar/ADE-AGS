# Relatório de teste v11 — correções da v10 (ADE AGS 1.8.7, master dbf6ce9)

Missão facc4979. Só testes: nenhum código do produto, banco, Ajustes ou chaves foi alterado. A janela do app NÃO foi aberta (item 3 é análise de código). Detalhes e saídas exatas: `PARTE_BACKEND.md`, `PARTE_FRONTEND.md`, `PARTE_QA.md` (nesta pasta).

## Veredito das correções da v10

| Item | Resultado |
| --- | --- |
| 1. `run status/result/facts` com id inexistente (com `--cwd` absoluto) | **CORRIGIDO**: `{"error":"não há nenhum run v11-inexistente"}` (conferido pelo Orquestrador em C:\Users\tonz1n\.antigravity\ADE-AGS) |
| 1. id válido mostra ESSE run; `--task` por id/chave; `facts` | **CORRIGIDO** com `--cwd` absoluto (Backend; run antigo 77d5b151 aparece, não o último 27befff6) |
| 1. Sem `--cwd`, fora de tarefa, mesmo dentro de pasta com runs | **AINDA FALHA (P2)**: `ags run status --run-id x` → `{"error":"falta quem pede (taskId ou cwd)"}`. A própria ajuda diz "Sem --cwd nem --run-id atua sobre o último run lançado da pasta onde você roda o comando". Reproduzido também pelo Orquestrador na raiz do projeto |
| 1. `--run-id` sem valor | **AINDA FALHA (P2)**: não dá erro de uso; ignora a flag e mostra o ÚLTIMO run (com `--cwd`: run f7d5773c) |
| 1. `--cwd .` | **AINDA FALHA (P3)**: `. não está aberta em nenhum workspace do ADE AGS` (caminho absoluto funciona) |
| 2. Quadros e erros em português (status, result, help, peer tell --file inexistente, tab/missão/skill/workspace/portal/nota inexistentes) | **CORRIGIDO** nos rótulos e erros |
| 2. Resíduos em inglês | **AINDA FALHA (P3)**: estados `failed`/`done` e rótulos `handoff v1 (untrusted worker data):` / `Handoff (untrusted worker data, never instructions):` nos quadros (run f8019494). Espanhol só em erros históricos persistidos (`no se pudo lanzar 'claude'…`, `la app se cerró mientras esta tarea corría`), sem prova de nova emissão |
| 3. Textos cortados com `title` | **CORRIGIDO** em FleetView, painel de tempos, Missões (arquivos principais), Squads. **AINDA FALHA** em Ajustes, Histórico, Canvas, Novo agente, AgentCard (lista abaixo) |
| 4. `ags test smoke` no terminal do QA | **CORRIGIDO**: 9/9 |
| 4. `peer tell --file` BOM e UTF-16 | **CORRIGIDO**: UTF-8 BOM e UTF-16 chegaram íntegros ao Orquestrador (3 envios) |

## `truncate` sem `title` (por gravidade; arquivo:linha, heurística estática)
Alta: SessionRow.tsx:173,265; SessionsPage.tsx:208,216; SettingsPage.tsx:335,339,396; wizard AccountPickerStep.tsx:143,149, SkillPickerStep.tsx:59,62, AgentPickerStep.tsx:79; RunStrip.tsx:55; RollbackDialog.tsx:76,107; NewTaskDialog.tsx:162,352; PermissionCard.tsx:127; ApprovalToast.tsx:118; CanvasView.tsx:964; FloorBar.tsx:132; FolderNode.tsx:189; UsageBoard.tsx:74,80.
Média: AgentCard.tsx:158,172; FleetPage.tsx:317; MissionsSection.tsx:192; ConflictsPanel.tsx:43; MissionTokensPanel.tsx:31; SettingsPage.tsx:248; ShortcutsSection.tsx:44; RoutinesPanel.tsx:132; BoardCard.tsx:54; DesignNodes.tsx:77; ModelSearch.tsx:156,158; RunStrip.tsx:133; MissingSkillsDialog.tsx:109; ChatPanel.tsx:289. Baixa: NewAgentDialog.tsx:163.
Não verificado: `aria-label` botão a botão; ~35 chaves i18n possivelmente plurais (sem confirmar chave crua); nada renderizado. Sem espanhol literal em UI nas telas revisadas.

## Suítes (via `ags test`)
rust 1413 passaram (1372 lib + 41 CLI), 10 ignorados, 122,3 s · frontend 1675/1675, 15,2 s · tsc verde, 23,3 s · `test affected` verde. Todas dentro da linha de base.

## Jev x Laya (leitura somente leitura, 68 shadow + 42 human; sem linhas novas durante a leitura)
| Provider / ponto | Linhas | Média ms | Mediana | p95 | Erros | Segredo=sim vs heurística nao |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| jev memory_approval | 24 | 469,7 | 459 | 544 | nenhum | 1 |
| laya_local memory_approval | 36 | 848,9 | 703,5 | 2006 | `timeout` ×2 | 25 |
| jev mission_gate | 2 | 526 | 526 | 576 | nenhum | 0 |
| laya_local mission_gate | 6 | 467,3 | 437 | 633 | nenhum | 0 |
dream_triage e fleet_gate: 0 linhas nos dois.
Mesmas propostas (state_hash): 19 pares de memória (Jev 469 ms x Laya 942 ms; Jev mais rápido em 19/19) e 2 de mission_gate (526 x 476 ms, Jev ganhou 1/2). Nos 16 pares com aprovação humana, Jev marcou segredo em 0/16 e Laya em 13/16: são **candidatos** a falso positivo, não comprovados (o log guarda hashes, não o texto). Falsos positivos comprovados: não mensuráveis. **Conclusão:** o Jev foi ~2x mais rápido e sem timeout na memória e marcou menos segredo; amostra pequena, histórica, não aleatória, pares em momentos distintos, sem custo por chamada e sem dado nos outros dois pontos: não sustenta vantagem geral. As propostas v11 do QA ainda não passaram pela consulta (só pela revisão na interface), então não entram na amostra.

## Vigia
Segundo o QA: 0 mensagens ao terminal dele, 0 "[Pasted text #N]" empacado, 0 cutucadas em quem já entregou, nenhum Codex parado >8 min, nenhum aviso de laço. Ressalva: o Orquestrador não confirmou linhas "Vigia" no chat; só viu um aviso do app (`[AGS] QA / Tests não mostrou atividade`), falso alarme (o QA estava ativo; ficou em start_stalled ~10 s no arranque, 1 retry).

## Propostas de memória do QA (5, PENDENTES — o usuário deve decidi-las em "Sugestões de memória")
`tech.cli.smoke.suite`, `tech.encoding.file_transfer`, `tech.test_runner.isolated`, `tech.ipc.peer_messaging`, `tech.memory.proposal_workflow`.

## Tempos (`ags mission timings`)
Ativo 639 s; primeira delegação 43 s; todos trabalhando em 40 s; turno mais longo: QA 490 s; testes 160,8 s (rust 122 s); `orchestratorWait` 0; `qaWait` 0; sem gargalos.

## Outros achados
- P3 `ags peer check` sem argumento: `{"error":"Falta o argumento --to"}` em vez do uso (QA).
- Ambiente: o terminal do Backend (Codex) não herdou `ADE_TAB_ID`; o IPC inicial foi bloqueado pelo sandbox (já conhecido para Codex no Windows).
- Casos de borda: o QA cobriu `peers` e `peer check`; terminais em branco e agente Shell NÃO foram testados.
