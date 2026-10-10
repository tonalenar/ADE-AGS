# Relatório de teste v10 (ADE AGS 1.8.7, master b64b04f)

Missão de teste: nenhum código do produto foi alterado. A janela do app não foi aberta (item 3 e revisão de UI feitos por código). Nada foi escrito em `~/.ags/data.db`; Decisões, chaves e Contas não foram tocados.

## Confirmação das correções da v9

| # | Item | Veredito |
|---|------|----------|
| 1 | `--run-id` em `run status` / `run result` / `run facts` | **AINDA FALHA** |
| 2 | CLI em português | **PARCIAL** (`--help` sem espanhol; restam mensagens, ver abaixo) |
| 3 | Decisões (provedor na discordância, rótulo dos botões, "Obrigatória") | **CORRIGIDO** (por código) |
| 4 | `title` nos textos cortados | **PARCIAL** (SettingsRow hint, título da missão, MissionOverview, Squads corrigidos; sobraram vários) |
| 5 | `ags test smoke` no terminal do QA; `--file` BOM e UTF-16 | **CORRIGIDO** (9/9; ambos íntegros) |

## Achados por gravidade

### P1 — `--run-id` ignorado e `--task` perdido (AINDA FALHA)
Reprodução (`--cwd` numa pasta com dois runs):
- `ags run status --cwd <pasta> --run-id v10-inexistente` → exit 0, mostra o último run (`27befff6…`) em vez de "não há nenhum run v10-inexistente".
- `ags run status --cwd <pasta> --run-id 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0` (run válido de outro run) → mostra o último run, não o pedido.
- `ags run result --cwd <pasta> --task 9a644dcb-… --run-id <qualquer>` → `{"error":"falta 'task' (key ou id)"}` mesmo com `--task`.
- `ags run facts --cwd <pasta> --run-id v10-inexistente` → exit 0, lista vazia.
- Sem run na pasta, os três devolvem "ainda não há nenhum run lançado desta pasta" em vez de "não há nenhum run <id>".
- Causa (Backend, por código): a CLI envia o mapa plano de flags como `Request.args`, mas o handler lê `payload.args` (`src-tauri/src/bin/cli.rs:399`, `ipc/commands/runs.rs:38`, `runs/orchestration.rs:72,86,121`). Contorno: `--json-args '{"args":{"runId":…}}'` funciona.
- Conferido pelo Orquestrador: dentro do worktree, `ags run status --run-id v10-inexistente` devolve "falta quem pede (taskId ou cwd)".

### P2 — flag com valor aceita sem valor
`ags run status --cwd <pasta> --run-id` (sem valor) devolve sucesso com o último run; `tab output --tab` e `peer tell --file` acusam corretamente.

### P2 — mensagens fora do português
- Espanhol no formatador de `ags run status`: "hasta 1 en paralelo"; em `run result`: "intentos 0 · costo ?".
- Inglês: `ags run status --json-args '{invalid}'` → "… key must be a string at line 1 column 2" (parser).
- Inglês: `ags memory get --id x` fora de tarefa → "…exigem uma tarefa Lead ou Worker" (conferido). `ags memory open` fora de tarefa está em português.
- `ags --help`: sem espanhol; restam termos ingleses na prosa ("modo Fast", "UNTRUSTED DATA", "os custom").
- Em português (ok): `peer tell --file` inexistente, tab, missão, skill, workspace, portal e nota inexistentes.

### P3 — texto cortado sem `title` (Frontend, por código; amostra conferida pelo Orquestrador)
- Médio: `settings/SettingsSection.tsx:64` (rótulo), `missions/MissionTimingsPanel.tsx:180` (valor da métrica), `runs/AgentCard.tsx:158,172,179` (card da Frota), `missions/MissionsPage.tsx:871,885` (tarefa e resumo da missão; também :435, :578), `missions/FleetView.tsx:87–97`.
- Baixo (varredura heurística, pode haver `title` no pai): MissionTokensPanel:31, ShortcutsSection:44, ConflictsPanel:43, RunStrip:55/133, NewTaskDialog:162/352, ModelSearch:156/158, SessionRow, SessionsPage, wizards de aba, Canvas (UsageBoard, RoutinesPanel, BoardCard, DesignNodes, FloorBar, CanvasView, ChatPanel), Workspaces*, PageHeader, PopupSelect, ContextMenu, AppDialog, ShellModal, StatusBar, ActivityRail.

### P3 — detalhes de UI
- Decisões: o texto visível do botão "Apagar a chave do cofre" segue genérico; só `title`/`aria-label` trazem o provedor (`DecisionsSection.tsx:102`).
- pt-BR usa "Guardar" (`sharedMemory.saveAnyway`, `fleet.rollback.create`), enquanto o padrão do app é "Salvar".
- i18n: pt-BR, en e es têm as mesmas chaves; nenhuma chave crua. Nenhum botão só-ícone sem rótulo nas áreas varridas (não cobre ícone em wrapper). Nada de espanhol visível em pt-BR.

## Item 3 (Decisões) — detalhes
- Discordância mostra o provedor e a key inclui o provedor: `DecisionsSection.tsx:504-505`.
- Os dois "Apagar a chave" têm `title`/`aria-label` com o provedor (`:330`, `:384`; pt-BR "Apagar a chave de {{provider}} do cofre").
- Dica do Jev "Obrigatória para este provedor…" (`pt-BR.json:261`).

## Suítes (via `ags test`, sem cache)
| Suíte | Resultado | Tempo |
|---|---|---:|
| frontend | 200 arquivos, 1675 testes passaram | 13,9 s |
| tsc | passou | 16,7 s |
| rust | lib 1371 passaram (10 ignorados); CLI 41 passaram | 126,9 s |
| affected | passou, sem testes mapeados | — |

## Jev x Laya (sqlite somente leitura, histórico; a v10 não gerou consultas novas)
| Provedor / ponto | Linhas | Média ms | Mediana | p95 | Erros | Timeouts | segredo=sim |
|---|---:|---:|---:|---:|---:|---:|---:|
| jev / memory_approval | 14 | 469,5 | 457 | 566 | 0 | 0 | 1 |
| laya_local / memory_approval | 31 | 848,6 | 687 | 2006 | 2 | 2 | 21 |
| jev / mission_gate | 1 | 476 | 476 | 476 | 0 | 0 | — |
| laya_local / mission_gate | 5 | 471 | 425 | 633 | 0 | 0 | — |
| dream_triage, fleet_gate | 0 | — | — | — | — | — | — |

- Erros do Laya (texto exato): IDs 16 (2013 ms) e 18 (2006 ms), ambos "timeout".
- Mesmas propostas (14 state_hash pareados): Jev 469,5 / 457 / 566 ms; Laya 974,3 / 783,5 / 2006 ms; timeouts 0 x 1. Jev ~52% mais rápido na média.
- segredo=sim: Jev 1/14, Laya 11/14. Nas fixtures `qa-v9-01..08` (sem credencial, **confirmado pelo QA**; os corpos não foram impressos): Jev 0/8, Laya 6/8, ou seja, 6 falsos positivos do Laya e nenhum do Jev.
- Concordância com a decisão humana: 6/11 para cada provedor (todas as 11 decisões foram "aprovar"); sem vantagem de qualidade.
- Conclusão: o Jev mostrou vantagem de latência e de menos marcações de segredo, não de concordância humana. Amostra pequena, histórica e por conveniência; sem generalizar.

## Vigia e QA
- Vigia: 0 mensagens no chat e nos terminais; 0 "[Pasted text #N]" empacado; 0 cutucadas em quem já entregou; nenhum aviso de laço (Backend ativo, sem tela parada por mais de 8 min).
- Smoke 9/9 no terminal do QA.
- `peer tell --file`: BOM UTF-8 e UTF-16 (`Out-File`) chegaram íntegros ("ação, coração, café, vovó, maçã, atenção").
- Primeiro comando do Backend (Codex) falhou com `helper_unknown_error: setup refresh had errors` (sandbox conhecido); depois perdeu `ADE_TAB_ID` no shell e recuperou por `tab list`.
- `[AGS] QA / Tests não mostrou atividade` surgiu logo após o briefing, mas o QA já estava rodando o smoke (falso alarme leve).

## Propostas de memória do QA (PENDENTES — decidir em "Sugestões de memória")
`qa-v10-1`, `qa-v10-2`, `qa-v10-3`, `qa-v10-4`, `qa-v10-5` (ids de entrada: 81e497b7…, 325ae4d5…, 34b5b8e2…, c22859b5…, 50c84d87…). `ags memory suggest` não dispara consulta ao Jev/Laya; isso só ocorre na revisão pela interface.

## Tempos da missão (`ags mission timings`)
Ativo 481 s; primeira delegação 43 s; todos trabalhando em 37,3 s; espera do Orquestrador 0; testes 157,5 s no total (frontend 13,9, tsc 16,7, rust 126,9); 1 `start_stalled` do QA no arranque.
