# Relatório de teste v14 — chat da equipe (ADE AGS 1.8.7, master 7be8cb5)

Missão bbe782a6. Só teste: nenhum código de produto foi alterado. A janela do app NÃO foi aberta (tela conferida por código e banco). Detalhes e saídas exatas: `V14_BACKEND.md`, `V14_FRONTEND.md`, `V14_QA.md`.

## Resultado por item

| Item | Resultado |
|---|---|
| 1 Chat da equipe, texto (mission_messages) | FUNCIONA (tell/ask gravados com mission_id e nomes certos; `ask` traz a pergunta; nada fora de missão). Falha baixa: teto grava 6001 chars (F5) |
| 2 Chat da equipe, tela (por código) | FUNCIONA nos requisitos; bugs de lógica abaixo (F2–F4, F8–F9) |
| 3 Resumo do orquestrador | FALHA PARCIAL: resumo curto aparece ao fim de todo turno, mas descreve o que cada integrante fez (F3) |
| 4 Uma missão, uma branch | FUNCIONA: 0 PRs abertos (`gh pr list --head 'cc/*' --state open` vazio), 0 branches no remoto, 4 branches locais (as pré-criadas: Orquestrador + 3 integrantes); ninguém criou branch, push ou PR |
| 5(a) truncate sem title em Workspaces | FALHA: os 4 locais seguem sem `title` (F6) |
| 5(b) `ags peer check` sem argumento | CORRIGIDO: `Uso: ags peer check <nome> [--lines 60]`, exit 2 |
| 5(c) falso alarme "não mostrou atividade" | FALHA: reproduzido às 22:04:03 (mission_timings 2582, start_stalled): "[AGS] QA / Tests não mostrou atividade após o briefing (recebeu um Enter)…"; o Antigravity registrou a 1ª saída às 22:04:18 (F7) |
| 5(d) memória aprovada sem decisão humana | NÃO CONFIRMADA regra automática (F10) |
| 6 Regressão | FUNCIONA: `ags test smoke` 9/9 no terminal do QA; BOM e UTF-16 íntegros (banco e terminal); `ags run status/result/facts --run-id` inexistente → exit 1, sem valor → exit 2, válido → exit 0 (result exige `--task`) |

## Achados por gravidade

- **F1 (média, intermitente) — teste Rust de encerramento deixa processo órfão.** `terminal::test::tests_e2e::matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente` (`src-tauri/src/terminal/test.rs:484`): "el nieto 36812 quedó huérfano tras matar el grupo". `ags test run rust`: 1375 passaram, 1 falhou; `--force` na mesma árvore: 1376 + 45 verdes. Falhou 1 de 2 execuções; causa não determinada.
- **F2 (média) — mensagens duplicadas no feed.** `TeamFeed.tsx:24-35`: `pull()` roda por evento `cc-peer-message` (150 ms) e por intervalo de 5 s; `last.current` só avança no `.then`, então duas chamadas em voo trazem as mesmas mensagens (duplicadas, chave React repetida). Conferido por leitura do código.
- **F3 (média) — resumo do Orquestrador descreve cada integrante.** Via `ags peer check Orquestrador` (QA, 22:18) e nos turnos do próprio Orquestrador. O briefing pede "sem descrever o que cada integrante fez". Ressalva: o briefing do QA não trazia o bloco "RESUMO AO FIM DE CADA TURNO" (exclusivo do briefing do líder), como esperado.
- **F4 (baixa) — compositor.** `ChatPanel.tsx:239` `@Backend` sem texto mostra "agente não achado"; `@Backend, x` (vírgula/dois-pontos) falha; `ChatPanel.tsx:235` sem Orquestrador aberto a mensagem sem `@` vai ao 1º agente sem aviso; nomes com a mesma 1ª palavra casam sem aviso. (Relatado pelo Frontend; não reproduzido na UI.)
- **F5 (baixa)** — `clip` em `missions/messages.rs:46` mantém 6000 chars e acrescenta "…": o texto persistido tem 6001.
- **F6 (baixa)** — `truncate` sem `title`: `WorkspacesPanel.tsx:144`, `DeletedWorkspacesList.tsx:64`, `WorkspaceList.tsx:62`, `WorkspacesPage.tsx:140` (conferido). A conferir: `runs/AgentCard.tsx:125`, `canvas/ResponsePicker.tsx:59`, `FloorBar.tsx:132`.
- **F7 (baixa) — falso alarme de "não mostrou atividade"** (timeout de 25 s antes da 1ª saída do Antigravity, 15 s depois). Quando o agente está só inicializando.
- **F8 (baixa, não verificado)** — `y`/`n` poderiam decidir 2 cartões se feed e Missões/Frota estiverem montados juntos.
- **F9 (baixa)** — `ask` do Backend ao QA ocupado expirou em 60 s (`peer_ask` timeout), mas a pergunta foi gravada.
- **F10 (baixa) — trilha de decisão sem autoria.** `decision_human_log` só guarda id, ts, point, state_hash e decision. Na v13, 5 propostas foram aprovadas no mesmo segundo (92–112 s após criadas, não ~26 s); o frontend tem "aprovar todas/selecionadas" (`MemoryInbox.tsx:143,195,197`). Não há regra de aprovação automática; decisão em lote é inferência, não prova. Na v14, as 6 propostas ficaram `proposed` (imediato, 60 s, ~177 s e ~4 min depois).

## Propostas de memória pendentes (decidir em "Sugestões de memória")

`qa_test_framework_vitest`, `qa_compiler_tsc_check`, `qa_syntax_babel_check`, `qa_backend_rust_cargo`, `qa_e2e_smoke_validation`, `qa_code_quality_lint`.

## Jev x Laya (leitura histórica; zero pares da v14, porque `ags memory suggest` não dispara a consulta)

| Provider / ponto | Linhas | Média ms | Mediana | p95 | Erros / timeouts |
|---|---:|---:|---:|---:|---|
| jev memory_approval | 40 | 471,65 | 460,5 | 542 | 0 / 0 |
| laya_local memory_approval | 36 | 848,92 | 703,5 | 2006 | 2 / 2 ("timeout") |
| jev mission_gate | 5 | 558 | 576 | 618 | 0 / 0 |
| laya_local mission_gate | 6 | 467,33 | 437 | 633 | 0 / 0 |
| dream_triage, fleet_gate | 0 | — | — | — | — |

Nos mesmos `state_hash`: 19 pares em memory_approval (Jev 469 ms de média x Laya 942 ms; Jev mais rápido em 19/19); 2 pares em mission_gate (sem vantagem média do Jev). `segredo=sim` em 14 textos técnicos banais recuperados: Jev 0/14, Laya 11/14. Conclusão: vantagem observada do Jev em latência e em falsos positivos de segredo, mas a amostra é pequena e histórica (19 e 14 itens, 2 no gate); não justifica sozinha o custo remoto. `decision_human_log`: 74 linhas, todas aprovar, sem provider.

## Vigia

Estava DESLIGADO (`ags.vigia.enabled == false`); o botão do olho fica na interface e não foi ligado (janela não aberta). Logo não há contagem útil/ruído. Observado no terminal do QA: 0 mensagens espúrias, 0 "[Pasted text #N]" empacado, 0 cutucadas em quem já entregou. O Codex (Backend) trabalhou 12 min 53 s sem aviso de laço porque chamava ferramentas e a tela mudava; o aviso de >8 min com tela parada não foi exercitado. Nenhum laço de raciocínio vazio do Codex foi observado.

## Tempos (`ags mission timings`)

Missão ativa 995 s; 1ª delegação em 48,6 s; todos trabalhando em 44,3 s; `orchestratorWaitMs` 0 e `orchestratorStallCount` 0; 1 `start_stalled` (F7); 12 execuções de teste somando 200,9 s (maior: rust 115,9 s); turno do Backend 963,9 s.

## Suítes

Frontend 1707/1707 (20,8 s), tsc verde (18,6 s), Rust 1376 + 45 verdes na repetição (43,6 s; ver F1), `ags test affected`: "Nada a testar" (só docs).

## Fora de escopo / não verificado

Tela do app não aberta (nada visual verificado); Vigia desligado; teto de 2000 mensagens verificado só por teste existente, não no banco real; casos de borda do Shell/terminais em branco: ver `V14_QA.md`.
