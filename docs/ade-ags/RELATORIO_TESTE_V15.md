# Relatório de teste v15 — Vigia ligado (mesma missão bbe782a6)

Só teste: nenhum código de produto foi alterado; a janela do app NÃO foi aberta. Detalhes e saídas exatas: `V15_BACKEND.md`, `V15_FRONTEND.md`, `V15_QA.md`. O Vigia foi ligado pelo usuário no botão do olho antes da delegação; o interruptor não grava horário, então só se sabe que a ativação é anterior ao primeiro sinal (22:23:26).

## Balanço do Vigia (chat.json, `vigia_report`)

- 3 avisos no chat da missão (22:23:26 e duas linhas às 22:24:35): 1 útil, 2 ruído/imprecisão (67% ruído; amostra de 3, não generalizar).
  - ÚTIL: detectou o diálogo "Set up security" do Codex travando o painel do Backend (já conhecido).
  - RUÍDO: atribuiu as 6 propostas de memória do QA ao Backend (e as 3 do Orquestrador ao Orquestrador sem distinguir autoria) e pediu para ligar o olho já ligado.
- Nos terminais: 0 linhas `[Vigia]` no QA; 0 "[Pasted text #N]" empacado; 0 cutucadas em quem já entregou (até 22:36:28, nos 4 terminais).
- Aviso de laço do Codex (>8 min com tela parada): condição e testes coerentes por código (`vigia.ts:272-274`, só missões `running`, só Codex), mas não foi exercitado: o Codex chamou ferramentas o tempo todo e a tela mudou (Backend trabalhou 12 min 53 s sem aviso na v14). Nenhum laço de raciocínio vazio observado.
- Falso alarme "não mostrou atividade" (5c): não reproduziu na v15 (explicação do QA: o watchdog de boot não atua em redelegações; sem teste).

## Achados por gravidade

- **G1 (média/alta, por código, não executado) — `y`/`n` pode decidir dois cartões de permissão.** `features/runs/PermissionCard.tsx:100-117` escuta `window` sem checar visibilidade (só ignora input/textarea e Ctrl/Cmd/Alt); chat, canvas e editor ficam sempre montados com `visibility:hidden` (`AppShell.tsx:267-279`); `MissionsPage.tsx:489/803` e `FleetPage.tsx:154` têm o mesmo atalho. Um `y` decide os dois e pode aprovar um pedido oculto. Conserto sugerido: só o cartão visível escuta o teclado (dono único).
- **G2 (média) — avisos do Vigia não aparecem na aba Equipe.** `vigia.ts:239-240` → `vigia_report` → `src-tauri/src/missions/vigia.rs:175-185` grava em `chat.json` (`chat::push`), nunca em `missions::messages::record`. A aba Equipe (aberta primeiro em missão, `ChatPanel.tsx:93`) só renderiza `TeamFeed` (`mission_messages` + permissões + notas): os avisos ficam só no chat do Orquestrador. Confirmado por Backend (código e dados: 3 linhas em `chat.json`, 0 em `mission_messages`) e pelo Frontend.
- **G3 (média) — duplicação no feed (reconfirmada).** `TeamFeed.tsx:21-40`: `pull()` por evento (150 ms) e por poll de 5 s usam o mesmo `afterId`. Conserto: flag de chamada em voo com reexecução, dedup por id e `last.current` = maior id aplicado.
- **G4 (média) — resumo do Orquestrador volta a descrever cada integrante** (QA: turno 22:26 cumpriu; turno 22:28 detalhou Frontend e Backend por nome).
- **G5 (média, por código) — `memberFinished` conta qualquer mensagem como entrega.** `vigiaPoke.ts:25` usa `reportedAt >= taskAt`; `vigia.ts:391` define `reportedAt` para qualquer peer enviado (inclusive pergunta/status). Exemplo real da v14: pergunta do Backend ao QA marcou como entregue. Além disso, a decisão do modelo é assíncrona (até 120 s) e o callback (`vigia.ts:360-370`) não revê se o integrante entregou enquanto isso: risco de cutucar quem já entregou (não observado).
- **G6 (baixa, por código) — "mandei a …" sem recibo.** `terminalRegistry.ts:177-186` deixa na fila se não há terminal; `vigia.ts:369-370` pode registrar envio no chat sem comprovar recebimento. Falha de `vigia_report` é engolida por `catch` (ação sem registro).
- **G7 (baixa) — compositor** (`ChatPanel.tsx:235-239`): `@Nome` sem texto mostra "agente não achado"; `@Nome, x`/`@QA: x` falha (o caractere seguinte precisa ser espaço); sem Orquestrador aberto vai ao primeiro agente sem aviso; nomes com a mesma primeira palavra vão ao primeiro sem ambiguidade.
- **G8 (baixa) — `truncate` sem `title`:** `runs/AgentCard.tsx:125` (parcial, só o cwd tem), `canvas/ResponsePicker.tsx:59`. `FloorBar.tsx:132` está correto. (Os 4 de Workspaces da v14 seguem pendentes.)
- **G9 (baixa) — ruído do Vigia** (2 de 3 avisos; texto exato em `V15_BACKEND.md`).
- Observação baixa: botão do olho tem rótulo e `aria-pressed` redundantes (`CanvasDock.tsx:186`); funciona, com i18n pt/en/es.

## Regressão e testes

`ags test smoke` 9/9 no terminal do QA; `ags test affected` verde (só docs). `ags test run rust`: UMA chamada, verde por cache; NÃO mede recorrência do flake da v14 (F1 do relatório v14 segue sem causa). Casos de borda: 6 abas estáveis (Claude, Codex, Antigravity, Shell).

## Fora de escopo / não verificado

Janela do app não aberta (aparência dos avisos, atalhos e feed não vistos); G1 e G5 não executados; horário exato de ativação do Vigia desconhecido; aviso de laço de 8 min não exercitado.
