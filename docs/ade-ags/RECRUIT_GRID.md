# Grade de recruits no canvas

O canvas da Mission posiciona o lead e os membros em duas linhas, preenchidas por coluna: o lead fica no topo, o primeiro recruit abaixo, o segundo à direita do lead, e o terceiro abaixo dele. Essa ordem vem de buildMissionTeam, gridCell e MISSION_GRID_ROWS em src/features/canvas/board.ts.

Quando chega um evento canvas.recruited pelo CLI, o estado identifica o lead do canvas e os membros já conectados a ele. A pane nova começa na próxima posição da sequência. Se outra pane, nota ou portal ocupa essa célula, o recruit avança para a próxima célula livre da grade.

As panes existentes não são movidas. Isso inclui terminais que já estavam no canvas antes do recruit e terminais recrutados depois da formação inicial do time. Cada colocação verifica as caixas atuais do canvas para evitar sobreposição.

handleRecruited em src/features/orchestrator/cliBridge.ts direciona o evento para o canvas do agente que recrutou. canvasActions.recruited em src/features/canvas/store.ts aplica a conexão e a posição.

Os testes relevantes ficam em src/features/canvas/tests/board.test.ts e src/features/missions/tests/terminals.test.ts.
