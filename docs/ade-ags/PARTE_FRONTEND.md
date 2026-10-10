# Parte Frontend (v11) — item 3 por código

A janela do app NÃO foi aberta; análise estática do código (worktree dbf6ce9), sem alterar código do produto.
Método: para cada `truncate` em .tsx (fora de testes), procurei `title=`/`aria-label` num intervalo de -4/+6 linhas. É heurística: um `title` num elemento pai pode não ser detectado (falso positivo possível); `truncate` com `title` mais distante também.

## Veredito por tela (item "textos cortados")
- Ajustes (SettingsPage dos painéis de tempos, atalhos): **AINDA FALHA (parcial)** — SettingsPage.tsx:248, 335, 339, 396 e ShortcutsSection.tsx:44 sem `title`.
- Painel de tempos (MissionTimingsPanel): **CORRIGIDO** — nenhum `truncate` sem title; MissionTokensPanel.tsx:31 (rótulo w-28) ainda sem.
- Missões (MissionsPage, MissionOverview, MissionMap, MissionChips...): **CORRIGIDO** nos arquivos principais; sobrou MissionsSection.tsx:192 (título da aba na barra lateral) e ConflictsPanel.tsx:43.
- Frota (FleetView): **CORRIGIDO** (0 achados). FleetPage.tsx:317 (dica "sortedHint") e AgentCard.tsx:158, 172: **AINDA FALHA** (158 fixRound; 172 linhas de atividade sem title).
- Squads: **CORRIGIDO** (nenhum achado). Histórico (sessions): **AINDA FALHA** — SessionRow.tsx:173, 265; SessionsPage.tsx:208, 216, 254.
- Canvas: **AINDA FALHA** — ver lista. Novo agente (wizard): **AINDA FALHA** — ver lista.

## `truncate` sem `title` nas telas pedidas (arquivo:linha)
Gravidade alta (texto de identificação/dado único que o usuário precisa ler inteiro):
- src/features/sessions/SessionRow.tsx:173 (título da sessão no Histórico), :265 (cwd)
- src/features/sessions/SessionsPage.tsx:208, :216 (workspace/caminho)
- src/features/settings/SettingsPage.tsx:335, :339 (nome e comando do agente), :396 (pasta de skills)
- src/features/tabs/wizard/AccountPickerStep.tsx:143, :149 (conta, max-w-40); SkillPickerStep.tsx:59, :62; AgentPickerStep.tsx:79
- src/features/runs/RunStrip.tsx:55 (objetivo do run); RollbackDialog.tsx:76, :107; NewTaskDialog.tsx:162, :352; PermissionCard.tsx:127; ApprovalToast.tsx:118
- src/features/canvas/CanvasView.tsx:964 (aba max-w-28), FloorBar.tsx:132 (max-w-40), FolderNode.tsx:189 (nome de arquivo), UsageBoard.tsx:74, :80
Gravidade média: AgentCard.tsx:158, :172; FleetPage.tsx:317; MissionsSection.tsx:192; ConflictsPanel.tsx:43; MissionTokensPanel.tsx:31; SettingsPage.tsx:248; ShortcutsSection.tsx:44; RoutinesPanel.tsx:132; BoardCard.tsx:54; DesignNodes.tsx:77; ModelSearch.tsx:156, :158; RunStrip.tsx:133; MissingSkillsDialog.tsx:109; ChatPanel.tsx:289.
Baixa: NewAgentDialog.tsx:163 (status com aria-live, curto).
Lista bruta completa (180 linhas, todo o app) gerada pelo mesmo script; as de fora das telas acima (forge, browser, marketplace, contas, graphify, scm, memory) não foram classificadas.

## Espanhol / i18n
- Espanhol visível: nenhum literal em UI nas telas revisadas; as ocorrências de espanhol em .tsx dessas pastas são só comentários de código.
- Chaves i18n: 3 locales (en, es, pt-BR). Das chaves `t("...")` literais usadas no código, ~35 não aparecem como chave exata em pt-BR/es (ex.: rail.fleetWaiting, canvas.links, forge.pr.commitCount, browser.captures, settings.accounts.count, canvas.usage.days, forge.comments...). Provavelmente são chaves plurais (_one/_other), não confirmei; **não verificado visualmente** — seria "chave crua" só se faltar o sufixo no JSON.
- botPanel.live.*. (LiveArcade.tsx) são chaves dinâmicas por prefixo (não checáveis estaticamente).

## Não verificado
- Botões sem `aria-label`: não auditei botão a botão (118 arquivos usam aria-label); fica pendente.
- Nada renderizado: tooltips reais, layout e cortes visuais só se confirmam com a janela aberta.
