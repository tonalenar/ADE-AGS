# Ao vivo no BotPanel

A quinta aba do BotPanel mostra uma missão por vez em um canvas pixel art. A missão exibida é a selecionada na aba Missões.

## v0

- Os cinco andares vêm de dados da missão: abertura usa spans de boot e briefing; trabalho e testes usam tarefas do run ativo e seus papéis funcionais; revisão usa tarefas de revisão e entregas; entrega usa o estado da missão.
- As escadas entre tarefas vêm de Task.dependsOn. Sem dependências registradas, nenhuma escada de tarefa é desenhada.
- Os sprites representam os provedores Claude, Codex e Antigravity encontrados nas tarefas da missão. Só correm quando sustainedTabIds aponta uma aba vinculada à missão; quando não há atividade sustentada, dormem.
- O placar lê tokens e estimativas da missão, tempo ativo registrado, orçamento configurado, tentativas e falhas das tarefas. Campos sem medição aparecem como “não medido”.
- O canvas atualiza a até 8 quadros por segundo enquanto a aba está visível e há agente ativo. A atualização pausa quando a janela fica oculta e respeita prefers-reduced-motion. Não há áudio.

## v1

- **Barris** só nascem de fontes medidas: aprovação pendente do broker (`useRunsStore.approvals`), tarefa falhada ou teste com `checks` falhando, memória sugerida sem resposta (`memory_pending_counts` por missão) e `peer ask` que expirou (span `peer_ask` com detalhe `timeout`). Sem fonte, não há barril.
- **Limite honesto:** a espera ao vivo de um `peer ask` (quem espera quem) hoje só é gravada quando termina; enquanto está pendente o app não a expõe, então ela não vira barril. Para isso seria preciso persistir spans abertos.
- **Troféu** acende só com entrega real: branch de integração pronta (`ENTREGA PRONTA`) ou aplicada ao projeto (`INTEGRADO`). PR e CI não são medidos pelo app e ficam cinza ("não medido").

## v2

- Com mais de uma missão em execução aparece o seletor **TODAS | missão** e a visão unificada: um fliperama por missão lado a lado (cada um carrega os próprios dados). Clicar (ou Enter) em um fliperama abre a missão individual.
- Com uma só missão em execução não há seletor; vale a missão selecionada na aba Missões.

## v3.0 — um herói por terminal, movimento real

- **Um herói por terminal** da missão (shells ficam de fora): nome = nome do terminal, sprite por plataforma (Claude = raios, Codex = viseira, Antigravity = antena), cor por papel (orquestrador, backend, frontend, QA, revisão, outro; lido do nome do terminal e do papel da tarefa ligada).
- **Terminal → tarefa** só por elo real: a `sessionId` que a tarefa lançou, ou o nome do terminal igual ao nome da tarefa no plano (`planKey`/papel funcional). Sem elo, o herói fica no **chão** (andar desconhecido); nada é adivinhado. Tarefas headless (sem terminal) não geram herói.
- **Estado**: corre só com saída sustentada (`sustainedTabIds`); fica parado com `!` quando a tarefa ligada falhou ou tem aprovação pendente; senão dorme (`Z`).
- **Movimento**: vigas inclinadas e escadas alternando de lado. O herói anda até a escada, sobe um andar por vez até o andar da etapa (Abertura, Trabalho, Testes, Revisão, Entrega) e vai até a tarefa. Quem corre vai e vem perto da tarefa.
- **Render**: `requestAnimationFrame` limitado a ~12 fps, pausa com a janela oculta; com `prefers-reduced-motion` as posições são estáticas e não há loop. Sem som.
- Lógica pura em `liveArcadeModel.ts` (`deriveHeroes`, `taskOfTab`, `roleOf`) e `liveArcadeScene.ts` (`stepMotion`, `heroTargets`, `beamY`…); desenho em `liveArcadeDraw.ts`.
