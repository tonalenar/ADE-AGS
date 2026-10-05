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

## v3.1 — a torre

- A fase vira **construir a torre**, no chão à direita: um bloco por tarefa **concluída de verdade** (`status = done`), na ordem de `endedAt`, colorido pelo papel. Tarefas que faltam aparecem como contorno tracejado; canceladas e puladas não entram no total.
- Acima das tarefas: bloco de **integração** (cheio só com a branch de integração aplicada, `INTEGRADO`), e blocos **PR** e **CI** em **cinza com "?"** — o app não mede PR/CI, então nunca ficam verdes nem são inventados.
- A torre fica **pronta** (`complete`) quando todas as tarefas planejadas foram entregues e a integração foi aplicada; PR/CI não medidos não contam como verde.
- Quando uma tarefa passa de não concluída para `done` com o app aberto, o herói ligado a ela **carrega o bloco** (desce as escadas) até a torre e só então o bloco aparece. Sem herói ligado, com `prefers-reduced-motion` ou ao abrir a aba (o que já estava pronto), o bloco entra direto.
- Lógica pura: `deriveTower` e `newlyDone` em `liveArcadeModel.ts`.

## v3.2 — barris que rolam e visão unificada

- Os **barris** continuam vindo só de fontes medidas (aprovação pendente, falha ou teste falhando, memória sem resposta, `peer ask` expirado) e agora **rolam pela viga** do andar, ladeira abaixo (vigas pares para a esquerda, ímpares para a direita), recomeçando na ponta alta.
- O herói que o barril **trava** (a tarefa do barril, ou o terminal que fez o `peer ask` expirado) fica **parado com `!`** até a fonte do bloqueio sair; os outros heróis da mesma viga **pulam** quando um barril passa. Barril de memória não tem dono: só rola.
- Com `prefers-reduced-motion` os barris ficam parados na tarefa que travam e ninguém pula.
- A **visão unificada** (seletor TODAS | missão) não muda: cada missão tem seu fliperama e, portanto, **sua própria torre**.
- Limite mantido: o `peer ask` ainda pendente não é exposto pelo app, só o expirado.
- Lógica pura: `placeBarrels`, `heroLift`, `rollDir` (`liveArcadeScene.ts`) e `deriveHeroes({ barrels })`.

## v3.3 — Ao vivo para missões em terminais e logos pixel-art (Etapa 15)

### O problema das missões em terminais
Nas missões conduzidas inteiramente no canvas de terminais da ADE-AGS, não existem `Task`s do Mission Runtime (DAG). Com isso, as versões anteriores do fliperama mantinham todos os heróis parados na viga inferior (chão / equipe) sem qualquer evolução vertical pelos andares. O HUD de "Tempo ativo" frequentemente exibia "não medido" mesmo com a missão em execução.

### Sinais reais e andares por papel/estado
Para refletir o progresso real sem inventar tarefas fictícias, a versão 3.3 deriva o andar e a animação do herói diretamente dos sinais dos terminais e da comunicação entre agentes:

1. **Andar 1 — Abertura (`opening`):**
   - Agente em fase de boot, briefing ou em espera ativa antes do recebimento de tarefa.
2. **Andar 2 — Trabalho (`work`):**
   - Agentes de desenvolvimento (Backend, Frontend, etc.) com saída sustentada (`sustainedTabIds`).
3. **Andar 3 — Testes (`tests`):**
   - Agentes no papel de QA / validação ou executando suítes de testes (`cargo test`, `vitest`, `tsc`).
4. **Andar 4 — Revisão (`review`):**
   - Agentes de revisão de código (`code-reviewer`, `Revisor`) ou tarefas de auditoria/aprovação.
5. **Andar 5 — Entrega (`delivery`):**
   - Estado final da missão ou entrega concluída.

### Animação, vigas e escadas
- **Movimentação física:** Os heróis andam de verdade pelas vigas e utilizam escadas para subir ou descer entre os andares quando o papel ou estado é alterado.
- **Patrulha (`running`):** Enquanto há saída sustentada no terminal, o herói patrulha a viga do andar correspondente.
- **Dormência (`sleeping` / `Z`):** Quando o terminal fica quieto/inativo, o herói adormece.
- **Alerta (`!`):** Quando parado esperando resposta, com aprovação pendente ou `peer ask` expirado.

### Construção da torre por entregas finais
- Cada entrega final enviada por um integrante via `ags peer tell "Orquestrador"` adiciona um novo bloco à torre da missão.
- A torre passa a refletir fielmente o avanço e as conclusões dos membros em missões de terminais.

### Barris e HUD de Tempo Ativo
- **Barris:** Continuam restritos a fontes estritamente reais (aprovação pendente, checagens falhando, memórias sugeridas sem resposta, `peer ask` expirado).
- **Tempo ativo unificado:** O HUD consome `activeSeconds` e `activeSource` (fonte unificada da Etapa 14). Durante a execução da missão, exibe o tempo ativo medido em vez de "não medido"; na ausência comprovada de fonte, permanece neutro/cinza.

### Logos em pixel art 12x12 na legenda
- O antigo quadrado genérico ao lado da identificação do agente ("Orquestrador · Claude CORRENDO") é substituído por um logotipo pixel-art 12x12 de cada plataforma:
  - **Claude:** raios/centelha em tons característicos.
  - **Codex:** viseira estilizada.
  - **Antigravity:** antena e contorno cósmico.
  - **Gemini:** diamante/estrela de quatro pontas.
  - **OpenCode:** chaves de código estilizadas.
  - **Genérico:** terminal neutro para plataformas não catalogadas.
- Desenhados integralmente via Canvas / CSS puro, sem assets adicionais ou dependências externas.


## v4 — Ao vivo que funciona em terminais (Etapa 15)

Missões em terminais não têm tasks, então os heróis ficavam parados na viga "equipe". Agora o andar sai dos **sinais reais de cada terminal** (`terminalStage`, `deriveHeroes({ signals })` em `liveArcadeModel.ts`):

- **Abertura**: o terminal ainda não escreveu de forma sustentada (briefing/aguardando).
- **Trabalho / Testes / Revisão**: depois da primeira saída sustentada, pelo papel (QA → Testes, revisão → Revisão, o resto → Trabalho).
- **Entrega**: o terminal fez a entrega final, ou a missão está `done`.
- Heróis **andam** pela viga e **sobem as escadas** ao mudar de andar (`heroTargets` agora também coloca quem não tem tarefa na viga do andar); patrulham com saída sustentada, dormem quietos e ficam com `!` com barril real. Sem sinais (sem tarefa e sem `signals`) continuam no chão.
- **Entrega final** = `peer tell` de um integrante ao orquestrador no formato do briefing (resultado + testes) — `isFinalDelivery` em `arcadeSignals.ts`, alimentado pelo `useMissionWatcher` (sempre montado). Cada entrega coloca **um bloco na torre** e o herói o carrega até lá; com tarefas, o bloco continua sendo o da tarefa (sem contar duas vezes). Os sinais ficam só em memória da sessão.
- **Barris** seguem vindo só de fontes reais. Sem dado = cinza, nada inventado.
- **HUD "Tempo ativo"** usa a fonte unificada da Etapa 14 (`timings.active`, com `activeSeconds`/`activeSource` da missão como reserva) e mostra a fonte no tooltip.
- **Legenda**: o quadradinho virou um **logo pixel-art 12x12** da plataforma (Claude, Codex, Antigravity, Gemini, OpenCode, genérico), desenhado em canvas sem imagens externas (`platformLogos.ts`, `PlatformLogo.tsx`). Shells não viram herói; qualquer outro agente usa o logo genérico.

## Abas de missão (Etapa 15)

- Cada aba de missão do topo tem um **X**: fecha os terminais da missão. Com a missão **em andamento** pede confirmação (`closeMissionNeedsConfirm`); terminada ou rascunho fecha direto.
- Botão **Grade** ao lado de Abas/Canvas: mostra **todos os panes da missão lado a lado** (`canvas/gridMode.ts`). A opção é **individual por missão** e persistida (`ade-mission-grids` no `localStorage`); o padrão segue como antes. Os xterms não são remontados: a grade só desenha os huecos e o `TerminalPanel` os ubica.
