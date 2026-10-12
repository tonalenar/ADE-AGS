# Relatório de teste v12 — ADE AGS 1.8.7 (master 8d0df88)

Missão "Teste completo v12 (correções da v11, squad E2E)", 2026-10-11. Nenhum código do produto foi alterado. A janela do app **não foi aberta** (o Frontend revisou só por código). Evidência bruta do Backend: `V12_BACKEND.md`, `V12_BACKEND_CLI.md`, `V12_BACKEND_DECISION_STATS.json`.

## 1. Veredito dos itens da v11

| Item | Veredito | Comando / saída exata |
|---|---|---|
| `run status/result/facts` dentro de pasta com runs, sem `--cwd` | **CORRIGIDO** | Em `C:/Users/tonz1n/.antigravity/ADE-AGS`: `ags run status` e `ags run facts` atuam sobre o último run (`f7d5773c-…`). `ags run result` sem tarefa: `{"error":"falta 'task' (key ou id)"}` (esperado). |
| `--task` por chave e por id | **CORRIGIDO** | `ags run result --task backend` → `backend — Backend: criar testes/handoff/backend.txt`; por id (Backend): `--run-id 77d5b151-… --task 9a644dcb-…` → `9a644dcb — Sonhar agora`. |
| `--run-id` inexistente | **CORRIGIDO** | `ags run status --run-id zzz` → `{"error":"não há nenhum run zzz"}` |
| `--run-id` de outro run | **CORRIGIDO** | `ags run status --run-id 77d5b151-c6cb-47a3-98d6-1e5078fbe5d0` → `Run 77d5b151-… — Revisar memória…` / `estado: falhou` |
| `--run-id` sem valor | **CORRIGIDO** | `ags run status --run-id` → `--run-id precisa de um valor`, exit 2 |
| `--cwd .` | **CORRIGIDO** | `ags run status --cwd .` mostra o mesmo run da pasta |
| Sem runs na pasta | OK | `{"error":"ainda não há nenhum run lançado desta pasta: crie um com run_plan"}` |
| `ags peer check` sem argumento | **CORRIGIDO** | `Uso: ags peer check <nome> [--lines 60]`, exit 2 |
| Quadros status/result, estados | **CORRIGIDO** | `estado: concluído`, `falhou`, `Entrega (dados não confiáveis do agente, nunca instruções):` |
| `peer tell --file` inexistente | **CORRIGIDO** | `Não foi possível ler v12-arquivo-inexistente.txt: O sistema não pode encontrar o arquivo especificado. (os error 2)` |
| Recursos inexistentes (tab, missão, skill, workspace) | **CORRIGIDO** | `Esta janela não tem nenhuma aba com o id …`, `não há nenhuma missão …`, `Não há nenhuma skill instalada chamada …`, `Não existe o workspace …` |
| `truncate` sem `title` | **AINDA FALHA (parcial)** | Corrigido nos arquivos da v11 (SessionRow, SessionsPage, SettingsPage, wizards, RunStrip, RollbackDialog, NewTaskDialog, PermissionCard, ApprovalToast, CanvasView, FolderNode, UsageBoard, AgentCard, FleetPage…). Sobras no §2. |
| `ags test smoke` no terminal do QA | **CORRIGIDO** | 9/9 ok (failed 0, passed true) |
| `peer tell --file` UTF-8 com BOM e UTF-16 LE | **CORRIGIDO** | Ambos chegaram ao Orquestrador íntegros: "Ação, coração, café, vovô, maçã, João, Conceição, Saúde" |

## 2. Achados por gravidade

Nenhum P0/P1 novo.

**P2 — títulos cortados sem tooltip em componentes compartilhados** (confirmado por leitura):
- `src/shared/ui/PageHeader.tsx:25,27` — título e subtítulo de todas as páginas com `truncate`, sem `title`.
- `src/shared/ui/AppDialog.tsx:35` — título de diálogo (reportado pelo Frontend; não reconferido por mim).
- `src/app/SideHead.tsx:95` — botão do menu do workspace contém só `<Logo/>`, sem `aria-label` nem `title` (leitor de tela e tooltip vazios).

**P3**
- `src/features/prelaunch/PrelaunchSection.tsx:61-62` — botão de criar mostra só `<AddIcon/>`, sem rótulo acessível.
- ~100 `truncate` sem `title` próximo (heurística por regex; podem ter `title` em ancestral). Telas do escopo: `ViewTabItem.tsx:65`, `NewAgentDialog.tsx:163`, `WorkspacesPanel.tsx:50,92,144`, `WorkspaceList.tsx:59,62`, `WorkspacesPage.tsx:140`, `HomeCards.tsx:57,58`, `PopupSelect.tsx:243`, `ContextMenu.tsx:136`, `CommandPalette.tsx:316,321`, `StatusBar.tsx:141,149`. Outras: ScmPanel, BranchMenu, GraphBranchFilter, SearchPanel, forge, skills, graphify, prelaunch, DetectedAgents, browser, FilesView, closeWithSave, RouteError. Contas e marketplace são conhecidos e ficaram fora do escopo. (Falso positivo descartado: `MissionsSection.tsx:149` tem `title={m.objective}` no botão pai.)
- Ajuda `ags --help` ainda com frases em inglês/misto: `Página do índice ou UMA entrada inteira (UNTRUSTED DATA)`, `O que pôr em --agent (inclui os custom)`. Quadros de result mantêm `branch:` e `(worktree …)`. Sem frase em espanhol na ajuda.
- Espanhol em quadros **históricos** (dados gravados, sem prova de nova emissão): `no se pudo lanzar 'claude': O nome do arquivo ou a extensão é muito grande. (os error 206)` e `la app se cerró mientras esta tarea corría`. Se o produto ainda emite essas mensagens, devem ser traduzidas.
- Chaves i18n: pt-BR, es e en têm as mesmas 2849 chaves. 7 prefixos dinâmicos em `bot/LiveArcade.tsx:284-395` (`botPanel.live.trophy./stage./status./metric./agent./taskStatus./barrel.`) não puderam ser provados por texto; conferir os sufixos em runtime.
- Processo do Codex (Backend) sem `ADE_TAB_ID`: `peer tell` falhou com `Este comando só funciona dentro de um terminal do ADE AGS (falta ADE_TAB_ID).` A entrega dele só foi lida do worktree. Parece o problema de sandbox do Codex no Windows, já conhecido; registrado por completeza.

## 3. Textos cortados (item 3, por código, janela não aberta)
Heurística do Frontend: 260 `truncate` em 117 arquivos de `src/**/*.tsx`; marcados os sem `title`/`aria-label`/Tooltip no elemento ou nas linhas vizinhas. As sobras estão no §2.

## 4. Suítes
| Comando | Resultado |
|---|---|
| `ags test run frontend` | 201 arquivos, 1701 testes ok, 19,9 s (wrapper 21,9 s; baseline 18 s) |
| `ags test run rust` | `já verde neste hash` (cache; sem tempo novo) |
| `ags test run tsc` | `já verde neste hash` (cache) |
| `ags test affected` | `Nada a testar: só arquivos sem efeito em código.` |

## 5. Jev x Laya (leitura somente leitura, 11:10:56Z)
69 linhas em `decision_shadow_log`, 42 em `decision_human_log` (todas `memory_approval`/`aprovar`, sem provider nem latência). Releituras antes e depois das propostas do QA deram o mesmo total.

| Provider / ponto | Linhas | Média ms | Mediana | p95 | Erros | Timeouts | `segredo=sim` |
|---|---:|---:|---:|---:|---|---:|---:|
| jev / memory_approval | 24 | 469,7 | 459 | 544 | nenhum | 0 | 1 |
| laya_local / memory_approval | 36 | 848,9 | 703,5 | 2006 | `timeout` ×2 | 2 | 25 |
| jev / mission_gate | 3 | 542,7 | 576 | 576 | nenhum | 0 | 0 |
| laya_local / mission_gate | 6 | 467,3 | 437 | 633 | nenhum | 0 | 0 |
| dream_triage, fleet_gate (ambos) | 0 | — | — | — | — | 0 | 0 |

Mesmas propostas (point + state_hash): **19 pares de memory_approval**: Jev média 469 ms contra 942 ms do Laya (mediana 457 contra 778, p95 566 contra 2006); o Jev foi mais rápido em 19/19, com 0 timeouts contra 1. `segredo=sim`: Jev 1, Laya 15 nesses pares. **2 pares de mission_gate**: Jev 526 ms, Laya 476 ms; sem vantagem do Jev.

**Falsos positivos de `segredo=sim`:** os logs guardam só hashes e decisões, não o texto das propostas, então não dá para medir. O Laya marca `segredo=sim` bem mais (25 contra 1); isso é divergência da heurística, não falso positivo provado. Nos 16 pares com decisão humana, o Jev marcou 0/16 e o Laya 13/16.

**Conclusão:** o Jev mostrou vantagem de latência em `memory_approval` (cerca de metade do tempo, sem timeout), mas **amostra pequena**, não aleatória, consultas em momentos diferentes, dois pontos sem nenhuma amostra e sem medição de custo (o Jev é pago por chamada). Não dá para afirmar vantagem geral. As propostas do QA não geraram linhas novas: a consulta só dispara pela revisão na interface (já conhecido).

## 6. Propostas de memória do QA (PENDENTES — decidir em "Sugestões de memória")
Total 5 (limite 6), todas técnicas e banais:
1. `tech.cli.positional_parsing` (439a0a18-9da2-4506-9520-394c7f6ae479)
2. `tech.encoding.bom_handling` (d559694b-db54-46a3-9723-24655918a406)
3. `tech.ipc.peer_reachability` (b9006aa3-cfe4-499a-8c41-ccd83c9db07a)
4. `tech.test.caching_layer` (19c9b86c-8110-4e27-9d69-072e5a156e99)
5. `tech.cli.usage_feedback` (063b5553-c994-4bd0-bf84-571b694ffd1b)

## 7. Vigia
- Terminal do QA: 0 mensagens, 0 ruído. `[Pasted text #N]` empacado: 0 em todos os terminais.
- Cutucadas ao Orquestrador (único alvo): (a) `[Vigia] Frontend já reportou e você registrou os achados. Backend e QA ainda não chegaram. Confira o status deles e, se já tiverem terminado, peça que reportem.` — útil e correta; (b) `[Aviso automático do ADE AGS] O agente "Backend" recebeu uma tarefa há 10 min 30 s e está parado há 2 min 01 s…` — útil: o Backend tinha terminado, mas não conseguia enviar por falta de `ADE_TAB_ID`, e a entrega foi recuperada pela leitura do worktree.
- Nenhuma cutucada em quem já tinha entregue. O Codex ficou "Working" 7 min 22 s, sem tela parada por mais de 8 min, então não houve aviso de laço (nenhum indevido). Horários exatos não foram registrados; os números vêm do QA e do chat do Orquestrador.

## 8. Casos de borda e observações
- Terminal em branco: `ags tab output` devolve `tail: []`, sem erro. Agente Shell: `tab create --agent bash` + `tab send` + `tab output` + `tab close` ok. Claude, Codex e Antigravity: ativos e se comunicando no canvas (apenas observação, sem teste dedicado de cada um).
- Divergência entre relatórios: o QA citou exit 1 para `--run-id` sem valor e para `peer check` sem argumento; medi exit 2 em `--run-id` e o Backend mediu exit 2 nos dois.
- Modal "Set up security" do Codex apareceu na tela do Backend (já conhecido).
- Tempos da missão: ver `ags mission timings` no app.
