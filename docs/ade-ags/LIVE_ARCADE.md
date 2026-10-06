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

## Indicador nas abas

O indicador de missão nas abas (`MissionTabIndicator`) traz o robô em pixel art 13×10 representando o estado vivo da missão diretamente no topo da interface.

### Estados e prioridades
Os estados derivam de uma função pura (`deriveMissionIndicator` em `missionIndicator.ts`), sem React, seguindo a ordem estrita de prioridade sobre os sinais reais da missão:
1. **`done` / `failed` (status final):**
   - `status === "done"` → `state = "done"`, `workingCount = 0`. Selo estático dourado com chispas e comemoração única (salto) apenas na transição de término com a aba aberta.
   - `status === "failed" | "cancelled"` → `state = "failed"`, `workingCount = 0`. Robô estático translúcido (sem animação).
2. **`needsYou` (atenção humana prioritária):**
   - `needsAttention: true` (aprovação pendente, pergunta detectada na tela com inatividade ou alerta de agente parado) → `state = "needsYou"`. Bot oscilando em onda com badge `!` piscante e chamas acesas. Mantém o `workingCount` de eventuais outros agentes trabalhando em paralelo.
3. **`working` (trabalho ativo):**
   - `workingAgents > 0` (terminais da missão com saída sustentada medidos por `sustainedTabIds`) → `state = "working"`. Animação de propulsão/bobbing do bot, chamas acesas e contador numérico ao lado com o total de agentes ativos.
4. **`waiting` (em curso sem atividade):**
   - `status === "running"` sem nenhum terminal com saída sustentada → `state = "waiting"`. Olhos fechados (dormindo) e badge flutuante `zzz` sem chamas. Não inventa atividade.
5. **`idle` (sem atividade / rascunho):**
   - Qualquer outro status sem atividade → `state = "idle"`. Bot estático translúcido sem insígnia e sem chamas.

### Sinais estritamente reais
- **Zero adivinhação:** O status `running` da missão por si só nunca conta como trabalho — sem saída sustentada comprovada nos terminais (`sustainedTabIds`), a missão fica em `waiting`.
- **Atenção real:** Só acende `needsYou` quando há aprovação pendente no broker (`useRunsStore.approvals`), pergunta real com silêncio prolongado na tela (`screenQuestion` com `SCREEN_QUESTION_QUIET_MS`) ou alerta ativo do detector de stall (`useStallAlerts`).
- **Amostrador compartilhado:** Um único sampler compartilhado via `useSyncExternalStore` (`useMissionIndicatorSignals`) faz a amostragem estável das fontes de estado a cada 1 s, reutilizando instâncias inalteradas (`stableMissionIndicatorSignals`) para evitar qualquer re-render desnecessário da barra de abas.

### Regras de animação, reduced-motion e visibilidade
- **Sem timer por aba:** Proibido `setInterval`, `setTimeout` ou `requestAnimationFrame` por aba montada. Toda movimentação contínua ocorre exclusivamente via CSS keyframes (`mti-bob`, `mti-flicker`, `mti-wave`, `mti-blink`, `mti-float`, `mti-jump`, `mti-spark`).
- **Pausa em aba/janela oculta:** Quando `document.visibilityState === "hidden"`, um listener compartilhado de `visibilitychange` aplica `data-ags-hidden="1"` no elemento raiz (`:root`), congelando instantaneamente todas as animações (`animation-play-state: paused !important`). Ao mesmo tempo, o timer do amostrador é cancelado e a amostragem suspensa.
- **Acessibilidade (`prefers-reduced-motion`):** Respeita o media query do sistema `(prefers-reduced-motion: reduce)` tanto via CSS (`animation: none !important`) quanto via hook reativo `useReducedMotion()`. Com o modo reduzido ativo (`data-motion="still"`), as animações são desativadas e o estado é comunicado unicamente pela troca de ícones pixel art, cores e contador.
- **Não captura clique ou arraste:** O componente renderiza com `role="img"` acessível, sem capturar eventos de ponteiro com `stopPropagation()` ou `preventDefault()`. Cliques para alternar aba e gestos de ponteiro para arrastar ou organizar abas borbulham livremente para o container da aba.

### Localização (i18n)
Todos os títulos (`title`) e textos acessíveis (`aria-label`) são localizados nos idiomas oficiais da plataforma:
- **`pt-BR`:**
  - `missions.indicator.working_one`: "{{count}} agente trabalhando"
  - `missions.indicator.working_other`: "{{count}} agentes trabalhando"
  - `missions.indicator.waiting`: "Esperando: nenhum agente com atividade agora"
  - `missions.indicator.needsYou`: "Precisa de você: há um agente parado esperando resposta"
  - `missions.indicator.done`: "Missão concluída"
  - `missions.indicator.failed`: "Missão encerrada sem sucesso"
  - `missions.indicator.idle`: "Missão sem atividade"
- **`en`:**
  - `missions.indicator.working_one`: "{{count}} agent working"
  - `missions.indicator.working_other`: "{{count}} agents working"
  - `missions.indicator.waiting`: "Waiting: no agent active right now"
  - `missions.indicator.needsYou`: "Needs you: an agent is stopped waiting for a reply"
  - `missions.indicator.done`: "Mission completed"
  - `missions.indicator.failed`: "Mission ended unsuccessfully"
  - `missions.indicator.idle`: "Mission idle"
- **`es`:**
  - `missions.indicator.working_one`: "{{count}} agente trabajando"
  - `missions.indicator.working_other`: "{{count}} agentes trabajando"
  - `missions.indicator.waiting`: "Esperando: ningún agente con actividad ahora"
  - `missions.indicator.needsYou`: "Te necesita: hay un agente detenido esperando respuesta"
  - `missions.indicator.done`: "Misión concluida"
  - `missions.indicator.failed`: "Misión terminada sin éxito"
  - `missions.indicator.idle`: "Misión sin actividad"



## O GLITCH, a história e o tempo ao vivo

- **Lore:** o GLITCH, um bug ancestral, roubou o troféu da entrega e se escondeu no topo da torre. Uma linha da história alterna a cada 7 s sob o título (pt-BR/en/es).
- **Inimigo:** o GLITCH patrulha a viga de Entrega. A barra de vida é REAL: tarefas concluídas / planejadas (ou, em missões em terminais, entregas finais / integrantes). Missão concluída ou tudo entregue = derrotado, e a equipe comemora. Os barris continuam sendo os golpes dele (só fontes reais).
- **Combate:** cada herói com saída sustentada (`running`) dispara tiros (cor do papel) que voam em arco até o GLITCH, que pisca ao ser atingido. Os tiros são cenário: não mudam a vida.
- **Nunca parados:** quem espera (`!`) treme, quem dorme respira e os Z sobem; com `prefers-reduced-motion` tudo fica estático.
- **Tempo ativo ao vivo:** o HUD avança 1 s por segundo enquanto a missão roda e algum herói trabalha, partindo da leitura unificada (`activeSeconds`); nunca volta atrás ao chegar uma leitura nova.

## Sprite e level-up do mascote

O sprite do bot (`src/shared/brand/Mascot.tsx`) segue a proposta B "pernilhas + bracinhos" da prancheta "Bot mesclado": a cabeça mantém a silhueta de sempre (arredondada, com antena); embaixo, quatro perninhas à la Clawd com vão no meio, coladas no corpo (nascem dentro da faixa de sombra e o pé "levanta" encolhendo a perna presa ao quadril), (membros em laranja `--mascot-limb`, com a ponta amarela `--mascot-limb-tip`) e dois bracinhos curtos que só aparecem durante uma animação (`MascotLimbs`, CSS em `App.css`): trabalhando digita com os bracinhos e marca o ritmo com as pernas, esperando levanta um braço e bate o pé, e ao subir de nível os braços vão ao alto. Em repouso e com `prefers-reduced-motion` os bracinhos não aparecem. Do estágio 2 do pet em diante os olhos viram chevron `> <` (do Clawd, via `eyeShapes`/`eyeKindFor`); antes disso, blocos quadrados. Um único sprite serve ao painel do QG, ao cartão da Home (via `Pet`) e ao logo (`MascotMark`).

O level-up segue a proposta C "Arcade" da prancheta "Level-up" do Canvas de Design: ao subir exatamente um nível com o pet à vista, o bot se agacha e salta, um flash em degraus, 14 confetes pixel (paleta amarelo/laranja/ciano), a barra de EXP pisca e o número do LV gira como um slot (`LevelNumber`). A lógica pura (`isLevelUp`, `confettiAt`) e o gancho `useLevelUp` ficam em `levelUpFx.ts`: um único timer, só durante o efeito (1,5s), sem intervalo por instância. Com `prefers-reduced-motion` não há salto, flash, confete nem slot: o número só troca. Só apresentação; nenhuma regra ou dado muda.

## Aura: contorno luminoso

A aura do bot segue a proposta C "Contorno luminoso" da prancheta "Aura estilo Super Sonic": um halo dourado que acompanha a silhueta (cabeça e pernas) em duas camadas borradas (larga laranja-dourada e estreita quase branca) atrás do bot, dentro do grupo que flutua. Só a opacidade pulsa (barato) e o ritmo depende do estado (`haloModeFor`): ocioso calmo (3s), trabalhando rápido (0,7s), esperando amarelo (1,1s) e branco-dourado intenso durante o level-up. Com `prefers-reduced-motion` o halo fica fixo. Convive com o brilho radial e as chamas das fases do pet; só apresentação.

## Humores novos, olhar e indicador das abas

- **Dormindo e falhou** (`MascotState`): só no repouso (pedir ação e trabalhar continuam vencendo). `failed` quando a última tarefa a terminar falhou há menos de 5 min (`FAILED_WINDOW_MS`); `sleeping` quando nada esteve ativo por 10 min (`SLEEP_AFTER_MS`). A derivação é pura (`mascotStateFor` com sinais, `mascotSignalsFrom`); o relógio é um intervalo único e preguiçoso de 30s (`nowTick.ts`), que não corre com a janela oculta nem sem ninguém escutando. Dormindo: olhos fechados, pernas encolhidas, Z subindo, halo quase apagado. Falhou: olhos em X, bracinhos caídos, pernas abertas e tremor, halo vermelho. Textos i18n `status.mascot.*` e `home.status.*` em pt-BR/en/es.
- **Olhar o cursor** (`cursorLook.ts`): em repouso os olhos seguem o cursor e o bracinho do lado sobe quando o cursor está acima. Um único ouvinte `pointermove` e um único `requestAnimationFrame` para todos os bots, que só existem enquanto algum bot em repouso está montado; desligado com `prefers-reduced-motion`.
- **Indicador das abas de missão**: desenha o mesmo sprite (`MASCOT_BODY`, `MascotLimbs`, `MascotEyes`) a 1px por célula, sem aura; o estado se lê pelos olhos (trabalhando laranja, precisa de você amarelo, concluída verde em chevron, esperando ciano fechado, falhou vermelho em X) e pelas insignias. Com movimento: digita/rebate ao trabalhar, levanta um bracinho ao precisar de você, salta com os braços ao alto ao concluir. Sem movimento, sem bracinhos.
