# Auditoria completa de performance — 2026-11-13

## Resumo

A auditoria combina leitura do código com uma compilação de produção medida. O maior dado objetivo do frontend é o chunk inicial main: **1.956.450 bytes (1.956 kB), 587,26 kB gzip**. O Vite transforma **1.737 módulos** e alerta que o chunk passa de 500 kB. Há code splitting (185 arquivos JS gerados), mas o grafo do shell inicial continua grande.

Não foi possível medir tempo de abertura da janela, primeira UI interativa, React Profiler, throughput de PTY/IPC em execução, CPU/memória em repouso nem CEF com página real. A tentativa isolada do Tauri foi interrompida antes de lançar a janela: a compilação nativa levou **140,82 s** até o cancelamento e o build do CEF pode buscar runtime por um script próprio, fora do modo offline do Cargo. Nenhuma instalação, janela ou banco real foi tocado.

O streaming do chat e a descoberta Wi‑Fi do iPhone estão cobertos pela auditoria parcial e pelas mudanças do [PR #334](https://github.com/tonalenar/ADE-AGS/pull/334). O lag do divisor do painel lateral está em correção no branch perf/resize-painel; não repliquei esse diagnóstico nem essa correção.

## Escopo e método

- Base: gh/dev, commit 60d2c784.
- Build frontend: bun run build, reutilizando as dependências já presentes em outro worktree por symlink temporário; não rodei bun install.
- Inventário estático: rg nos pontos citados abaixo. Contagens de call sites e timers são inventário de código, não taxas de execução.
- Tamanhos agregados: bun -e usando statSync e gzipSync nos artefatos de dist/assets. Para o tamanho individual, usei o relatório impresso pelo Vite.
- Tentativa de arranque: CARGO_NET_OFFLINE=true ADE_AGS_DATA_DIR=<diretório temporário> bun run tauri dev. Foi cancelada antes de o staging do CEF concluir; a pasta temporária foi isolada em /tmp.

## Achados priorizados

Impacto e esforço são estimativas para priorizar uma próxima rodada; não são medidas de runtime. “Não medido” identifica métricas que exigem sessão real, carga ou perfilador.

| Prioridade | Impacto × esforço | Causa / evidência | Medição | Correção proposta |
|---|---|---|---|---|
| P1 | Alto × médio | O shell inicial importa muitos hosts e superfícies juntos: AppShell traz sidebar, chat, command palette, canvas sync, terminal host e observadores em imports estáticos (src/app/AppShell.tsx:5-57). As rotas secundárias já usam lazy() (src/app/router.tsx:18-29), mas isso não reduz por si só o chunk comum. main.tsx importa quatro famílias de fontes globalmente (src/main.tsx:2-5). | bun run build: 1.737 módulos; 185 arquivos JS no total, 7.941.477 bytes / 2.459.833 bytes gzip no grafo inteiro. Entrada HTML: 4 JS, 2.336.611 bytes / 715.611 gzip. O idioma pt-BR exigido antes do primeiro render acrescenta 398.438 bytes; caminho necessário até montar React ≈ **2.735.049 bytes / 828.983 gzip**. Chunk main: 1.956.450 bytes / 587,26 kB gzip; Vite alerta >500 kB. O build também empacota **42 arquivos WOFF2, ~1,6 MB**; download efetivo até o primeiro paint não medido. | Mover hosts raros para carregamento sob demanda; dividir o shell comum por superfície sem desmontar Terminal/browser; avaliar subset e carregamento de fontes; gerar orçamento de chunk inicial por release. |
| P1 | Alto × alto | Chat monta cada turno e item pendente com turns.map e pending.map (src/features/chat/timeline/ConversationTimeline.tsx:324-327). Não há biblioteca de virtualização nas dependências do frontend. O transcript pode conter saída e Markdown longos. | Não medido: sem perfil React e sem transcript de carga reproduzível; rg confirmou renderização por lista e ausência de react-window, react-virtual, @tanstack/react-virtual e virtuoso. | Virtualizar por turno com altura dinâmica e preservar scroll âncora, foco, seleção e acesso a mensagens anteriores. Primeiro medir 100/500/2.000 itens em harness. |
| P1 | Alto × médio | PTY: Rust lê até 64 KiB por chamada de read e emite um evento Tauri para cada leitura não vazia (src-tauri/src/terminal/pty_manager.rs:1047-1079); o frontend chama term.write por evento (src/features/terminal/Terminal.tsx:361-370). O tamanho do buffer não significa que cada evento tenha 64 KiB. | Não medido: bytes/s, eventos/s, payload JSON e latência de escrita/renderização precisam de PTY real e saída controlada. O código estabelece buffer máximo de leitura de **64 KiB** e um emit por retorno de read. | Criar benchmark local com saída determinística e medir vários tamanhos/velocidades; se IPC dominar, agrupar leituras por janela curta/frame, sem atrasar eco interativo ou replay. |
| P2 | Médio × baixo | Cinco componentes usam store Zustand sem seletor, assinando o objeto inteiro: CommandPalette, UpdateNotifier, UpdatesSection, SearchPanel e ClosingProgress (src/features/palette/CommandPalette.tsx:128; src/features/updates/UpdateNotifier.tsx:29; src/features/updates/UpdatesSection.tsx:13; src/features/search/SearchPanel.tsx:61; src/app/closeWithSave.tsx:86). | Inventário medido: **5 call sites** em rg -n 'use[A-Za-z0-9]+Store\(\)' src --glob '*.tsx'. Re-renders por minuto não medidos: requer React Profiler com stores sendo atualizadas. | Trocar por seletores das propriedades usadas; manter ações via getState(); instrumentar Profiler antes/depois nos fluxos de chat, terminal, frota e paleta. |
| P2 | Médio × baixo | Sidebar renderiza todos os cards abertos da seção (src/features/chat/ChatSidebar.tsx:718-755); frota renderiza todos os shown tasks (src/features/runs/FleetPage.tsx:278-290); canvas deriva coleções de nodes e as passa ao React Flow (src/features/canvas/CanvasView.tsx:424-488,806-808). | Não medido: não há tamanho de workspace/canvas do usuário nem contagem de nós montados em execução. Inventário confirma três superfícies sem virtualização própria. | Virtualizar sidebar e frota quando listas excederem um limiar; manter renderização espacial do React Flow sob perfil e limitar a busca quadrática de relações quando o board crescer. |
| P2 | Médio × baixo | Atualizações de relógio por cartão: cada tarefa viva da frota mantém um setInterval(1000) (src/features/runs/AgentCard.tsx:13-25); detalhes de shell em execução consultam saída a cada 2 s (src/features/chat/tasks/TaskDetail.tsx:11-27). | Medido no código: **1 timer por cartão vivo, a cada 1 s**, e **1 chamada de leitura por detalhe aberto a cada 2 s**. Número de cartões e IPCs simultâneos em uso real não medido. | Usar relógio compartilhado por página e manter polling de saída apenas no detalhe visível; cancelar quando oculto ou inativo. |
| P2 | Médio × médio | CEF no macOS agenda CefDoMessageLoopWork na fila principal do GCD com teto de 33 ms entre chamadas (30 Hz) (src-tauri/src/real_browser/cef_native.rs:334-365). A posição do navegador também depende de real_browser_place e retângulos da UI (src/features/browser/RealBrowserView.tsx:41-68). | Cadência de código: até **30 chamadas/s** enquanto o pump segue ativo. CPU/GPU em repouso, custo de página e custo durante resize não medidos; nenhum browser CEF foi aberto nesta auditoria. | Medir sem página, aba oculta, página parada e navegação; avaliar pump adaptativo/pausa sem quebrar menus, resize, CDP ou callbacks pendentes. |
| P2 | Médio × médio | Rotinas de missão e canvas mantêm clocks/polling próprios; exemplo: observação de atividade a cada 2 s, flush de atividade e ciclo do Vigia a cada 30 s (src/features/missions/watcher.ts:105-112,250-276; src/features/missions/vigia.ts:43-47,676-681). Uso/canvas também tem sweep periódico (src/features/canvas/usageStore.ts:180-197). | Inventário estático: **59 ocorrências de setInterval** em src/ fora de testes; não representa timers simultâneos. Não medido: CPU wakeups, timers vivos com app ocioso, listeners após trocar telas. | Registrar timers por owner e estado de visibilidade; medir com canvas vazio, missão ativa/inativa e frota encerrada; garantir unsubscribe/cleanup nos ciclos. |
| P2 | Médio × médio | Painel de memória renderiza itens da página, inbox e revisões com map (src/features/memory/SharedMemoryPanel.tsx:272,527,610,627; src/features/memory/MemoryInbox.tsx:248-262). Dispositivo flutuante mede caixa e mantém superfície React (src/features/chat/DeviceFloatCard.tsx:20-30); o simulador/mockup também mantém UI e animações (src/features/simulator/SimulatorChat.tsx:112, src/features/simulator/SimulatorBar.tsx:209); Android renova a lista em intervalo próprio (src/features/chat/DevicesPane.tsx:533-539). | Não medido: sem dataset da memória, aparelho/emulador ou uso do mockup/floating aberto. Busca por API nativa de Picture-in-Picture não encontrou referências; o floating da ADE é uma superfície própria. Frame time, nós, imagens e payload por refresh não medidos. | Medir memória com páginas grandes, mockup parado e em movimento, e floating aberto/oculto; aplicar paginação/virtualização onde o perfil apontar. |
| P2 | Médio × médio | iPhone Wi‑Fi usa descoberta com devicectl enquanto seletor está ativo. No branch base o intervalo é 4 s (src/features/iphone/store.ts:73-90). | **Já medido no PR #334:** uma execução de xcrun devicectl list devices levou 0,279 s; espera máxima do timer cai de 4 s para 2 s na correção daquele PR. Handshake Wi‑Fi real continua não medido. | Acompanhar o PR #334; não repetir a alteração do timer nem o benchmark de streaming. Medir pareamento/descoberta Wi‑Fi em aparelho real separadamente. |
| P2 | Médio × médio | A base compartilha Arc<Mutex<Connection>> (src-tauri/src/database/connection.rs:53-55). Há conexão lateral para operações que misturam SQLite com git/disco justamente para não reter o mutex global durante I/O (src-tauri/src/database/connection.rs:67-77). O schema contém 33 declarações CREATE INDEX. | Locks, duração de query, espera pelo mutex e EXPLAIN QUERY PLAN com banco grande: **não medido**; não acessei ~/.ags/data.db nem havia uma base de benchmark isolada. Contagem de índices é inventário estático, não prova de cobertura. | Instrumentar tempo de espera/posse de lock e consultas lentas; montar fixture sintética isolada; comparar planos antes de propor índice; mover disco/git/modelo para fora do lock. |
| P2 | Médio × baixo | CSS usa materiais com backdrop-blur e saturação em composer, toolbar e dock de canvas (src/features/chat/ChatComposer.tsx:722-727; src/features/canvas/CanvasToolbar.tsx:58-61; src/features/canvas/CanvasDock.tsx:80). Há também medidas de geometria distribuídas pela UI. | Busca estática: **58 ocorrências** de backdrop-filter/backdrop-blur/filter: blur e **184 ocorrências** de leitura de geometria (getBoundingClientRect, offsetWidth/Height, clientWidth/Height, scrollHeight). GPU time, layout/reflow e frame drops: **não medidos**; ocorrência de API não prova layout thrash. | Fazer trace no canvas e no chat com resize/scroll; reduzir blur/sombra só onde o trace mostre repaint caro; evitar alternar leitura e escrita geométrica em um mesmo ciclo. O divisor lateral está em perf/resize-painel e fica fora desta correção. |
| P3 | Médio × médio | Markdown de conversa usa react-markdown; o wrapper lazy do canvas já difere o carregamento do Markdown (src/features/canvas/LazyChatMarkdown.tsx:3-13). O processamento inclui GFM e, em texto matemático, KaTeX (src/shared/ui/Markdown.tsx:1-12,137-154). | Build: chunk ChatMarkdown = **4,34 kB / 1,84 kB gzip**; chunks de CodeMirror = **368,07 kB / 118,94 kB gzip** e xterm = **607,77 kB / 157,11 kB gzip**, ambos fora do entry. Tempo de parse de transcript e syntax highlight: não medido; não há highlighter de código dedicado no caminho ReactMarkdown encontrado. | Medir parse e commit de transcript longo/streaming com Profiler; manter CodeMirror e xterm fora da entrada inicial; avaliar renderização incremental só com evidência. |

### Cobertura exigida e limites

| Área | Resultado da auditoria |
|---|---|
| Startup | Tamanho do bundle e estratégia de split medidos. Tempo até janela e UI interativa **não medido**: o build de dev não chegou a abrir janela; a compilação foi interrompida antes do estágio que pode buscar CEF. |
| Renderização React | Foram contados 5 seletores amplos e identificadas listas diretas de chat, sidebar, frota, canvas e memória. Frequência de rerender e frame time **não medidos** sem Profiler e dataset de carga. |
| Terminais/PTY | Buffer/caminho de emissão identificado (64 KiB por leitura, um evento por retorno de leitura). Throughput xterm, eventos/s, bytes serializados e terminais ocultos **não medidos** sem PTY ativo. O código limita WebGL às terminais visíveis (src/features/terminal/Terminal.tsx:146-184). |
| IPC Tauri | Inventário de chamadas fonte: 40 ocorrências de invoke/listen/emit em src-tauri/src/ipc + src-tauri/src/app; 72 de invoke/listen em src/shared + src/features. Isso não mede frequência/payload. Eventos por segundo, tamanho JSON e bloqueios de thread principal **não medidos** sem tracing em runtime. |
| Backend Rust | Conferidos mutex SQLite, uso de spawn_blocking, timers e índices do schema. Locks durante I/O externos não foram confirmados no caminho observado; contenção e query plans **não medidos** sem instrumentação e fixture. |
| Navegador, mockups, floating/PiP | CEF macOS tem pump de até 30 Hz; Browser e aparelho flutuante são superfícies próprias. Busca por API nativa de PiP sem resultado. CPU, GPU, memória, frame time e custo de página **não medidos**. |
| Canvas de missões e frota | Canvas passa arrays de nós/arestas ao React Flow; frota mapeia tarefas visíveis e cartões vivos atualizam relógio a 1 Hz. Contagens reais de nodes/tasks e custo de render **não medidos**. |
| Memória e Vigia | As listas de memória são mapeadas por página; Vigia usa ciclo de 30 s e os watchers incluem 2 s/atividade. Volume de dados, CPU ociosa, listeners vivos e efeito no banco **não medidos**. |
| iPhone/Wi‑Fi | Medição pontual e mudança do polling estão registrados no PR #334; não medi pareamento Wi‑Fi real. |
| Repouso/CPU/memória | **Não medido**: nenhum processo ADE desta auditoria foi lançado até a UI. Portanto não há amostra de CPU, RSS, wakeups ou vazamentos de listener que seja atribuível ao app. |
| Animações/CSS/layout | Foram enumeradas ocorrências de blur e APIs de geometria; sem captura de Performance/Rendering, não há atribuição de custo nem diagnóstico novo de layout thrash. |

## Top 10 de quick wins

1. Reduzir o grafo comum do AppShell e colocar hosts raros atrás de lazy boundaries, mantendo terminais e browser montados no mesmo ponto.
2. Trocar os cinco usos de Zustand sem seletor por seletores pequenos.
3. Colocar limite/virtualização adaptativa no transcript, preservando âncora e histórico.
4. Virtualizar cards da sidebar e da frota quando a quantidade passar de um limite medido.
5. Consolidar o relógio de 1 s da frota em um timer por página, em vez de um por cartão ativo.
6. Fazer leitura de saída de tarefa apenas no detalhe visível e pausar polling em janela/tela oculta.
7. Instrumentar por evento o PTY (bytes, payload serializado, eventos/s e tempo até xterm) antes de mudar batching.
8. Medir e, onde o trace comprovar custo, reduzir blur/saturação em elementos translúcidos durante movimento.
9. Adicionar métricas de boot e backend: janela, primeira render, UI pronta, lock wait/hold e queries lentas.
10. Medir o pump CEF vazio/parado/visível e adotar ciclo adaptativo somente se reduzir CPU sem piorar responsividade.

## Comandos de medição

~~~sh
bun run build
~~~

O comando acima roda TypeScript e Vite; o Vite imprime os tamanhos raw/gzip por chunk e warnings. No build observado: 23,17 s total (time -p), 5,74 s reportados pelo Vite. Não usar esse número como startup do app.

Os totais agregados foram calculados nos artefatos após esse build:

~~~sh
bun -e 'import{readdirSync,readFileSync,statSync}from"node:fs";import{join}from"node:path";import{gzipSync}from"node:zlib";const d="dist/assets",js=readdirSync(d).filter(n=>n.endsWith(".js"));const sum=ns=>ns.reduce((a,n)=>a+statSync(join(d,n)).size,0);const html=readFileSync("dist/index.html","utf8");const initial=[...new Set([...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map(m=>m[1]))];console.log({chunks:js.length,raw:sum(js),gzip:js.reduce((a,n)=>a+gzipSync(readFileSync(join(d,n))).length,0),entry:sum(initial),entryGzip:initial.reduce((a,n)=>a+gzipSync(readFileSync(join(d,n))).length,0)})'
~~~

A fórmula acima inclui apenas os JS declarados no HTML. O caminho de montagem também carrega o chunk do locale inicial (pt-BR, neste ambiente). Gzip agregado usa node:zlib; por isso pode diferir alguns bytes do gzip exibido pelo Vite.

## Verificação e itens não feitos

- bun run build: passou; TypeScript e Vite.
- Tauri dev isolado: iniciado com ADE_AGS_DATA_DIR temporário e Cargo offline; interrompido após 140,82 s, antes de janela. O script de build do CEF usa resolução/download próprio, então não continuei para respeitar “não instale nada”.
- Não rodei testes: a mudança neste branch é apenas documentação.
- Não medi React Profiler, carga de listas, PTY, IPC runtime, SQLite sob carga, CEF, iPhone real, CPU/RSS em repouso, layout/repaint.
- Não implementei correções neste PR.
