# Relatório v16 — correção do Vigia e da tela do chat (mesma missão bbe782a6)

Rodada de correção autorizada pelo usuário: código de produto alterado só nos itens abaixo (sem schema, instalador, CI, permissões, segurança, versões, Contas, chaves nem Decisões). Detalhes e saídas exatas: `V16_FRONTEND.md`, `V16_BACKEND.md`, `V16_QA.md`. A janela do app NÃO foi aberta: o comportamento visual não foi visto.

## Consertos (todos com teste novo)

| Item | Conserto | Verificação |
|---|---|---|
| G1 `y`/`n` decidia 2 cartões (`PermissionCard.tsx`) | Cartão escondido em ancestral (`visibility:hidden`/`display:none`) não responde ao teclado | `permissionCardKeys.test.tsx`: um `y` decide só o visível |
| G2 Vigia fora da aba Equipe | O aviso também vai para `mission_messages` (tell, `from_name` "Vigia", lead→lead, sem schema); o chat do agente continua; o feed mostra linha discreta "Vigia" (pt/en/es) e omite o destino quando origem e destino são o mesmo | testes Rust (`messages.rs`, `vigia.rs`) e `teamFeedModel.test.ts` |
| G3 duplicação no `TeamFeed` | `pull()` com chamada em voo + reexecução, dedup por id, `last` = maior id | `teamMessagesHook.test.tsx`, `teamFeedModel.test.ts` |
| G5 "já entregou" | Só entrega final explícita (`isFinalReport`: marcador explícito, `tell` sem `?`); `finishedAt` separado de `sentAt`; `vigia_check` revê o integrante antes de cutucar | `vigiaDelivery.test.ts`, `vigiaPoke.test.ts` |
| G6 "mandei a …" | Registrado só em `onSent`; falha de `vigia_report` vai para `console.error` | `vigiaDelivery.test.ts` |
| G7 compositor | `@Nome` sem texto pede o texto; `@Nome,`/`@Nome:`/`@Nome;` funcionam; ambíguo ou sem Orquestrador avisa e NÃO envia; i18n `canvas.team.emptyMention/ambiguousMention/noLead` | `teamFeedModel.test.ts` |
| G8 `truncate` sem `title` | `title` nos 6: `WorkspacesPanel`, `DeletedWorkspacesList`, `WorkspaceList`, `WorkspacesPage`, `AgentCard:125`, `ResponsePicker:59` | revisão de código |

## Validação

- QA, na árvore integrada: `ags test smoke` 9/9; frontend e tsc verdes; Rust 1376 + 45 verdes na repetição.
- **O teste Rust `matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente` FALHOU DE NOVO** na primeira execução do QA com `--force` ("el nieto 28540 quedó huérfano tras matar el grupo", 1375 passaram, 1 falhou) e passou na repetição. Com a v14 (neto 36812), são 2 falhas em 5 execuções registradas desta missão: o flake é real e recorrente, sem causa determinada e não relacionado a estas mudanças (nenhum arquivo de terminal foi tocado). Backend: 1377 verdes na sua execução.
- Rodada de correção do Backend bateu o teto de 2: o 2º vermelho era um teste novo que ignorava o cooldown de 4 min do Vigia (`VIGIA_COOLDOWN_MS`); o usuário autorizou uma rodada manual só de teste (2 linhas) e ficou verde.

## Vigia (acumulado v15–v16)

Na v16 não houve nova linha `[Vigia]` no terminal do QA, nem "[Pasted text #N]" empacado, nem cutucada em quem já entregou. O aviso de laço (Codex >8 min com tela parada) segue não exercitado: o Codex ficou >16 min ativo com chamadas de ferramenta contínuas. Aviso do Vigia sobre o Frontend ocioso foi correto (útil). Falso alarme 5(c): 0 ocorrências.

## Não verificado

Aparência do feed com as linhas do Vigia e dos atalhos (janela não aberta); a causa do flake Rust; o aviso de laço de 8 min ao vivo.
