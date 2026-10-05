# Ao vivo no BotPanel

A quinta aba do BotPanel mostra uma missão por vez em um canvas pixel art. A missão exibida é a selecionada na aba Missões.

## v0

- Os cinco andares vêm de dados da missão: abertura usa spans de boot e briefing; trabalho e testes usam tarefas do run ativo e seus papéis funcionais; revisão usa tarefas de revisão e entregas; entrega usa o estado da missão.
- As escadas entre tarefas vêm de Task.dependsOn. Sem dependências registradas, nenhuma escada de tarefa é desenhada.
- Os sprites representam os provedores Claude, Codex e Antigravity encontrados nas tarefas da missão. Só correm quando sustainedTabIds aponta uma aba vinculada à missão; quando não há atividade sustentada, dormem.
- O placar lê tokens e estimativas da missão, tempo ativo registrado, orçamento configurado, tentativas e falhas das tarefas. Campos sem medição aparecem como “não medido”.
- O canvas atualiza a até 8 quadros por segundo enquanto a aba está visível e há agente ativo. A atualização pausa quando a janela fica oculta e respeita prefers-reduced-motion. Não há áudio.

O v0 não infere PR, CI ou merge. Barris para bloqueios reais e troféu pertencem ao v1; vários arcades e o seletor de missões pertencem ao v2.
