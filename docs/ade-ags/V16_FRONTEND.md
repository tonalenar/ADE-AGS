# V16 — Frontend (correções de tela)

Antes: `git merge cc/mission-bbe782a6-ec77-4100-8509-cb6b7b23` (limpo). Janela do app NÃO aberta; conferido por testes (happy-dom) e código.

## G1 — y/n só no cartão visível
- `src/features/runs/PermissionCard.tsx`: novo `isHiddenInTree(el)` (sobe pelos ancestrais; `visibility:hidden` ou `display:none` → escondido), `ref` no cartão, e o `onKey` retorna se estiver escondido. Cartão do chat (canvas oculto por `visibility:hidden`, AppShell.tsx:267-279) deixa de responder atrás de /missions e /fleet.
- Teste novo: `runs/tests/permissionCardKeys.test.tsx` "cartão num ancestral escondido não responde" — dois cartões `focused`, um sob `visibility:hidden`; um `y` chama só o visível (1×).

## G3 — useTeamMessages sem duplicar
- `canvas/TeamFeed.tsx`: `pull()` com `inflight`/`again` (uma leitura por vez, reexecuta ao terminar), `last.current = max(ids)`, `setMessages` via `mergeMessages`.
- `canvas/teamFeedModel.ts`: `mergeMessages` (dedup por `id`, devolve a mesma lista se nada é novo).
- Testes: `canvas/tests/teamMessagesHook.test.tsx` (evento + poll de 5 s com leitura em voo → 1 `invoke`; depois reexecuta com `afterId: 2`; linhas repetidas não duplicam) e `teamFeedModel.test.ts` (`mergeMessages`).

## G7 — menções
- `teamFeedModel.ts`: `resolveMention` → `none | ok | empty | ambiguous | unknown`; aceita `,` `:` `;` depois do nome; `parseMention` virou wrapper (compatível). Mesmo rótulo em mais de um agente (1ª palavra igual, ou nome repetido) = ambíguo.
- `canvas/ChatPanel.tsx` `sendTeam`: `@Nome` vazio pede o texto (`canvas.team.emptyMention`); ambíguo avisa e NÃO envia (`canvas.team.ambiguousMention`); sem Orquestrador aberto e sem `@` avisa e NÃO envia (`canvas.team.noLead`, lista os nomes); desconhecido segue sem enviar.
- i18n novo em pt-BR, en e es: `canvas.team.emptyMention`, `ambiguousMention`, `noLead`, `vigia`.
- Testes: `teamFeedModel.test.ts` (`resolveMention`: vazio, vírgula/dois-pontos/ponto e vírgula, none/unknown, ambíguo e desempate pelo nome inteiro).

## G8 — `title` nos truncate
`WorkspacesPanel.tsx:144` (branch/“sem repo”), `DeletedWorkspacesList.tsx:64` (nome), `WorkspaceList.tsx:62` (resumo), `WorkspacesPage.tsx:140` (resumo · última atividade), `runs/AgentCard.tsx:125` (branch+cwd, ou cwd), `canvas/ResponsePicker.tsx:59` (rótulo). Sem teste novo (atributo de apresentação).

## G2 — avisos do Vigia no TeamFeed
- `teamFeedModel.ts` `isVigiaMessage` (`from_name` "Vigia", sem caixa); `TeamFeed.tsx` mostra essas linhas discretas: rótulo "Vigia"/"Watcher"/"Vigía" (`canvas.team.vigia`), `→ destino` se houver, texto em itálico cortado com `title`, hora. Mensagens normais e o modelo existente não mudaram.
- Contrato assumido (enviado ao Backend): `from_name == "Vigia"`, `kind` tell, `to_name` do agente avisado ou vazio. Sem resposta do Backend até a entrega; se ele usar outro `from_name`, ajustar `isVigiaMessage`.
- Teste: `teamFeedModel.test.ts` (`isVigiaMessage`).

## Validação
- `ags test affected`: passou (babel, tsc, frontend: 18 arquivos / 127 testes no related).
- `ags test run frontend`: 203 arquivos, 1715 testes passaram. `ags test run tsc`: passou (cache no mesmo hash `537ac992`). Rust não foi tocado.
