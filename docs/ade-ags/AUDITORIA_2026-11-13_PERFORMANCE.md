# Auditoria de desempenho da ADE — 2026-11-13

## Mudanças e medições

| Caminho | Antes | Depois | Prova |
|---|---:|---:|---|
| Agregação de deltas de chat: 4.000 deltas em 128 itens | mediana 8,13 ms | mediana 0,27 ms | `bun -e` comparando `inputs.reduce(appendDelta, [])` ao `appendDeltas`, com 9 amostras aquecidas de cada caminho; saída preservada: 128 rascunhos e 4.000 caracteres. Redução de 96,7% (30,3×). |
| Agregação de deltas de chat: 4.000 deltas em 1 item | mediana 1,25 ms | mediana 0,33 ms | Mesmo comando e método; redução de 73,7% (3,8×). |
| Consulta de aparelhos CoreDevice | — | 0,279 s por chamada | `time xcrun devicectl list devices --quiet --json-output "$tmp"`; uma execução local retornou 6 aparelhos. |
| Intervalo da busca enquanto o seletor de iPhone está ativo | 4 s (espera de descoberta de até 4 s) | 2 s (até 2 s) | Constante `LIST_EVERY_MS` em `src/features/iphone/store.ts`; limite derivado do intervalo do timer, não é medida de um pareamento real. |

O comando do microbenchmark criou 4.000 entradas com `itemId: m${i % k}` e `delta: "x"`, comparou o algoritmo anterior (`inputs.reduce(appendDelta, [])`) ao novo `appendDeltas`, aqueceu ambos duas vezes, coletou nove amostras e usou a mediana de `performance.now()`. É uma medição isolada do agregador, não do tempo ponta a ponta percebido numa conversa real. O novo caminho agrupa pedaços por id e junta cada sequência uma vez, evitando também concatenação repetida de strings no lote.

## Achados por prioridade

1. **Chat, cópia quadrática ao agregar rajadas de tokens — corrigido.** `appendDeltas` aplicava cada pedaço via `appendDelta`, que procurava e copiava o array de rascunhos a cada delta. Agora agrupa por item e concatena uma vez por quadro. A atualização do Zustand já era coalescida por `requestAnimationFrame`; o IPC Tauri ainda entrega um evento por delta.
2. **Descoberta de aparelhos Wi‑Fi, espera do polling — reduzida.** O seletor atualiza a lista em intervalos de 4 s e a requisição `devicectl` local levou 0,279 s. O intervalo passou a 2 s; o pior atraso de descoberta decorrente do timer cai de 4 s para 2 s. O comando tem timeout de 20 s, mas a chamada observada não se aproximou desse limite.
3. **Abertura do stream Wi‑Fi — candidato relevante, não alterado.** `src-tauri/src/iphone/model.rs` dá até 25 s para o primeiro quadro; falhas usam backoff de 0,5, 1, 2, 4 e depois 8 s. A documentação do próprio fluxo descreve 1–8 s para túnel e vídeo. Não medi um handshake Wi‑Fi real; reduzir o limite sem dados de aparelhos lentos arriscaria falhas falsos-negativas.
4. **Render da timeline longa — não medido.** Cada atualização do rascunho refaz a projeção de turnos e percorre `turns.map`; o markdown usa memoização do corpo processado por conteúdo, preservando o parse de mensagens cujo texto não mudou. Contagem de renders/React Profiler e custo de lista longa não foram medidos. Não adicionei virtualização sem um perfil de timeline real para definir janela e overscan.
5. **Envio de mensagem e banco — sem evidência de lock durante I/O no caminho examinado.** `send_framed` lê a conversa e solta o mutex do banco antes de obter/aguardar sessões e enviar ao agente. O tempo de bootstrap dos motores, serialização IPC e espera do agente não foi medido. Eventos `cc-chat-thread` continuam serializados e emitidos por delta.
6. **Startup, abas e terminais — não medido.** Permanecem itens para uma rodada com captura de cold start, troca entre abas e render de terminais; não há números comparáveis nesta auditoria.

## Verificação

- Vitest afetado: `bunx vitest run src/features/chat/tests/streaming.test.ts src/features/iphone/tests/store.test.ts`.
- TypeScript: `bunx tsc --noEmit`.
- Parser: `bun run check:babel`.
- Lint de testes: `bun run check:test-lint`.
- Rust do módulo iPhone: `cargo test --lib --bin ags iphone::test`.
- Pareamento/handshake Wi‑Fi real, Profiler React, serialização IPC, boot, abas e terminais: **não medidos**.
