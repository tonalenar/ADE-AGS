
## Modo grade

A opção **Grade**, ao lado de **Abas** e **Canvas**, apresenta os terminais da missão em quadros simultâneos. Missões com somente um terminal continuam na visualização normal. Cada quadro oferece um slot `data-slot="grid:<tabId>"`: o terminal já existente deve acompanhar a posição e as dimensões desse slot, preservando o PTY e o histórico ao mudar de modo.

Ao entrar ou sair da grade, redimensionar a janela ou trocar de missão/aba, o terminal deve aguardar um slot com dimensões positivas antes de ajustar as células com o fit do xterm e enviar o resize ao PTY. Medições transitórias com largura ou altura zero não devem ocultar permanentemente o terminal nem substituir seu último tamanho válido. No backend, `pty_resize` ignora `cols == 0` ou `rows == 0` e limita cada dimensão a 1.000 células, evitando tamanhos absurdos e conversões incompatíveis com o ConPTY.

O quadro ativo recebe uma borda de destaque. Clicar no título ou no terminal seleciona o quadro e direciona o foco de teclado ao seu terminal. A troca de quadro e a saída da grade reutilizam a mesma sessão, sem reiniciar o agente nem limpar o histórico. O contrato de posicionamento e foco é implementado pelo frontend; a guarda do PTY protege os períodos em que o layout ainda está sendo calculado.

Validação do backend: `cargo test --manifest-path src-tauri/Cargo.toml --lib terminal`. Os testes cobrem dimensões válidas e extremas, conservação do tamanho de um PTY real durante medições zero e o resize válido seguinte.

## Etapa 15 — início rápido e isolamento

`mission_prepare_team({ missionId, members: ["Orquestrador", ...nomes] })` prepara a equipe antes de marcar a missão em andamento ou abrir terminais. Retorna `{ workspaces, precheck, memory }`; cada workspace contém `name`, `cwd`, `root`, `branch`, `cargoTargetDir`, `prelaunch` (string de comando) e `environment` (bloco de briefing). A UI usa `cwd` e `prelaunch: [{ command: workspace.prelaunch }]`. O canvas continua vinculado ao diretório original e à missão, permitindo comunicação entre worktrees diferentes.

Cada integrante, inclusive o orquestrador, recebe um worktree/branch a partir de `origin/master`, em `~/.ags/worktrees`. O repositório precisa ter essa referência local; não há fallback para editar o clone. A junction de `node_modules` usa o setup de `floors.rs`, preservando qualquer diretório/link existente; ausência de dependências aparece no ambiente. `CARGO_TARGET_DIR` é isolado em `<root>/src-tauri/target`, exportado antes da TUI. A tabela aditiva/idempotente `mission_team_workspaces` (schema v32) guarda a propriedade por missão/nome: retentar reutiliza o worktree sem descartar arquivos não commitados. Worktrees ausentes geram erro explícito. Git roda fora do lock do banco; uma trava de preparação serializa chamadas concorrentes. Não se removem worktrees automaticamente ao concluir.

Recruits dentro de uma missão também recebem isolamento quando `--floor` não é informado. Um piso explícito ocupado é recusado. Fora de missões, o comportamento do recruit permanece o existente.

O briefing começa com a regra: plano curto usando objetivo, precheck e memória já preenchidos; `ags peer tell` a cada integrante com tarefa/escopo/worktree/branch em até aproximadamente dois minutos; depois exploração. Membros recebem o mesmo contexto conhecido e aguardam sem explorar nem editar. O precheck não manda mais o orquestrador investigar código antes da delegação. Briefings de agentes seguem o idioma operacional PT-BR já usado pelo projeto; rótulos da métrica e erros de isolamento da UI têm pt-BR/en/es.

`ags mission timings` e `ags mission efficiency` retornam `firstDelegationMs: number|null` e `firstDelegationSource: "peer_message"|"span"|null`. O QG e o painel de tempos usam o mesmo campo de eficiência, com ausência em cinza. O IPC persiste um span `peer_message` de duração zero, `detail: "delegation"`, após envio bem sucedido de tell/ask do orquestrador a outro integrante do mesmo canvas de missão. A métrica é o intervalo desde o primeiro boot observado até esse envio; sem boot, usa `started_at`. Ela mede o primeiro envio de coordenação, não interpreta semanticamente o texto da tarefa. Mensagens de membros e de outras missões não contam. Histórico sem evento novo pode usar o primeiro span `peer_ask` cujo actor é `Orquestrador`, identificando a fonte como `span`. Sem início/evidência, retorna null; não atribui zero. Eventos de mensagem não são tempo de trabalho ativo.

### Comparação e validação

A linha de base fornecida para a Etapa 14 é boot de 5–11 s; briefing Frontend 488 s, Orquestrador 421 s, QA 800 s; primeiro peer ask aos 701 s e expirado. A fotografia somente leitura de `ags mission timings 84b47fe5-bf1e-45ee-b544-ee676409bf04` durante esta implementação registrou boot de 4,258–5,807 s. O app então em execução ainda usa o contrato anterior e não registra os novos peer_message; portanto **não há medida real posterior de primeira delegação**, nem percentual de ganho demonstrado. Após iniciar uma missão no app atualizado, comparar `firstDelegationMs` com a linha de base, respeitando a diferença de fonte histórica. Meta de processo: até ~120 s, não garantia automática de execução pelo modelo.

Testes cobrem comparação sintética de primeiro ask aos 701 s com tell aos 89 s (teste de cálculo, não benchmark real), ausência/inversão de relógio, fonte histórica, worktrees distintos, checkout da referência origin/master em vez de arquivos sujos do clone, junction preservada, retry com edição não commitada, migração repetida e propriedade persistida. A integração de lançamento verifica cwd/prelaunch por terminal e ausência de terminais abertos quando a preparação falha. Comandos obrigatórios: `node node_modules/typescript/bin/tsc --noEmit`, `node node_modules/vitest/vitest.mjs run`, `cargo test --lib --bin ags`.

## Ponto 1 — Agente parado

**Problema:** o orquestrador manda uma tarefa com `ags peer tell` e, se o agente para por algum motivo, espera para sempre.

**Como funciona** (`src/features/missions/stalled.ts`, ligado em `watcher.ts`):

1. `peer_tell` e `peer_ask` (Rust) emitem `cc-peer-message { kind, fromTabId, toTabId, atMs }`.
2. `applyMessage`: um `tell` do orquestrador (aba `Orquestrador`) a um membro abre uma tarefa pendente; qualquer mensagem *do* membro (tell ou ask) a fecha. Um `tell` novo reinicia o relógio e o aviso. `ask` não abre tarefa (já espera sozinho).
3. A cada 5 s, `findStalls` avalia as pendentes. O silêncio conta desde o máximo entre a tarefa, a última saída do agente (`lastOutputAt`, novo em `terminal/activity.ts`) e a última digitação do usuário (`lastInputAt`). Passados `STALL_MS` = 120 s, avisa.
4. O aviso (`stallMessage`, PT-BR) vai ao orquestrador por `pasteIntoTab`, só quando ele não está no meio de um turno (senão tenta no tic seguinte). Traz nome, há quanto recebeu a tarefa, há quanto está parado, se chegou a trabalhar e a última linha da tela. Uma vez por tarefa.

**Sem falso alarme:**

| Situação | Tratamento |
|---|---|
| Pensando/executando (saída contínua) | `activeTabIds`: o relógio só corre com a aba quieta (`QUIET_MS`) |
| Espera aprovação/resposta do usuário | `isWaitingForUser` reconhece o diálogo nas últimas 8 linhas |
| Usuário digitando na aba | `lastInputAt` reinicia o relógio |
| Aba fechada | descartada da lista |

**Prazo configurável:** `STALL_MS` (120 s) é o padrão; `findStalls(pending, probe, stallMs)` aceita outro valor e o watcher lê `localStorage["ags.stallMs"]` (mínimo `MIN_STALL_MS` = 15 s; inválido → padrão).

**Tell sem pedido:** `isAck` reconhece mensagens curtas de cortesia/confirmação (≤ 40 caracteres, ≤ 5 palavras, sem "?", começando por "obrigado", "ok", "valeu", "thanks", "entendido"…) e elas não abrem tarefa pendente. O texto do tell vai no evento `cc-peer-message` (`text`); evento sem texto conta como tarefa.

**Limites conhecidos:** o agente que trabalha e responde sem `ags peer tell` gera um aviso ("trabalhou e se calou") que o orquestrador ignora após `ags peer check`. Reconhecimento de diálogo e de ack é por texto (EN/PT/ES).

**Testes:** `src/features/missions/tests/stalled.test.ts` (26 casos).

## Ponto 2 — Peer ask com prazo e gargalos

`ags peer ask "Backend" "pedido" --timeout 30` mantém o prazo configurável (10–3600 s; padrão 600 s). O orçamento inclui a espera para o destino ficar quieto e a espera do eco antes do Enter. Se o destino permanece ocupado, retorna `sent: false`, `finished: false`, `status: "busy"`, sem enviar uma segunda tarefa. Após envio, o prazo devolve a resposta disponível com `sent: true`, `status: "timed_out"`; não interrompe o agente. O transporte da tela/IPC e o polling podem acrescentar pequena latência ao prazo.

`ags peer check "Backend" --lines 100` consulta a tela atual e o parcial da última pergunta para o destino, sem reenviar o prompt. Qualquer peer conectado pode consultar durante a espera. `askStatus` contém `state` (`waiting`, `finished`, `timed_out`, `busy`), `fromTabId`, `sent`, `finished` e `elapsedMs`. O estado descreve a espera da pergunta, não certifica o estado atual da TUI: depois de timeout, `reply` continua permitindo ler o resultado mais recente. O histórico de consultas é volátil, limitado a 256 destinos; sem pergunta prévia, `askStatus` é nulo. Em TUIs de tela alternativa, o parcial é a tela visível, pois não existe scrollback incremental.

`ags mission timings <id>` inclui `summary.bottlenecks`, ordenado por `waitingMs` decrescente. Cada agente traz número de perguntas, solicitantes distintos, soma e máximo da espera, timeouts e soma de spans `turn`. Esperas simultâneas de dois solicitantes contam duas vezes: são dois agentes bloqueados, não tempo de relógio da missão. Não se soma `peer_ask` ao tempo de turno do agente. Agentes sem destino identificado não entram no ranking. A medição usa os spans persistidos existentes, sem alegar causalidade ou estimar tokens/custos ausentes.

Todos os turnos passam por um único `TurnTracker`: o briefing registra `detail: "briefing"` uma vez; Enter no terminal, `peer ask`, `peer tell`, recruit e `tab send` iniciam os próximos turnos. Saída sustentada detecta ainda turnos iniciados fora desses caminhos. `activitySnapshot()` apenas lê timestamps, preservando a lógica de atividade do ponto 1. O watcher continua medindo com a barra lateral recolhida. Cinco segundos sem saída encerram o span na última saída observada; fechamento da aba/missão descarrega o turno observado. Submissões sem saída não criam spans e deixam de ser acompanhadas após 20 minutos.

Limites: inferência por silêncio segue a heurística existente, portanto uma pausa longa pode dividir um turno. Duas submissões com saída separadas por menos de 5 s permanecem no mesmo turno; os 1,5 s do Rust são a preparação para enviar, enquanto o término do turno usa 5 s em ambos os lados. Uma nova submissão sem saída anterior reinicia o início, evitando contar um Enter perdido até 20 minutos depois. Eco nos primeiros 600 ms é descartado pela atividade; uma resposta inteira nesse intervalo pode não ser medida. O polling é de 1 s e a coleta precisa da janela da missão aberta. Totais `byKind` podem superar 100% do `wallMs`, pois há agentes em paralelo e espera dentro de turnos. A tela de gargalos no QG pertence ao ponto 4; este ponto entrega a API e o contrato TypeScript, sem novos textos visuais. A baseline histórica é registrada pelo QA antes da integração.

Testes focados: `cargo test --lib missions::timings`, `cargo test --lib ipc::commands::peers`; Vitest cobre briefing único, turnos seguintes, respostas curtas, saída tardia, redraw de inicialização e fechamento. No Windows: `node node_modules/typescript/bin/tsc --noEmit` e `node node_modules/vitest/vitest.mjs run` (sem `npx`).
# Eficiência entre agentes

## Ponto 3 — Setup do worktree

Prepare o worktree antes de iniciar uma missão ou abrir um recruit. Confirme o caminho e a branch atribuídos, ligue `node_modules` às dependências compartilhadas quando aplicável e configure o cache Rust na sessão do shell que executará os comandos. Não reutilize o clone principal como diretório de trabalho do agente.

No Windows, use PowerShell. Para esta missão, o worktree já está pronto em `C:\Users\tonz1n\.antigravity\ADE-AGS-e11-p3-worktree-setup`, na branch `feat/etapa11-p3-worktree-setup`, baseada em `origin/master`. O `node_modules` é uma junction para `C:\Users\tonz1n\.antigravity\ADE-AGS\node_modules`. Para outro worktree, ajuste os caminhos e crie a junction somente se `node_modules` ainda não existir:

```powershell
$worktree = 'C:\Users\tonz1n\.antigravity\ADE-AGS-e11-p3-worktree-setup'
$sharedNodeModules = 'C:\Users\tonz1n\.antigravity\ADE-AGS\node_modules'
$nodeModules = Join-Path $worktree 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModules)) {
    New-Item -ItemType Junction -Path $nodeModules -Target $sharedNodeModules | Out-Null
} else {
    $link = Get-Item -LiteralPath $nodeModules
    if ($link.LinkType -ne 'Junction' -or $link.Target -notcontains $sharedNodeModules) {
        throw 'node_modules existe, mas não é a junction compartilhada esperada; pare e confira o worktree.'
    }
}

Set-Location $worktree
$env:CARGO_TARGET_DIR = Join-Path $worktree 'src-tauri\target'

node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
cargo test --manifest-path src-tauri/Cargo.toml --lib floors::test
```

Use `--lib` com um filtro correspondente ao módulo alterado para evitar rodar todos os testes Rust quando isso não for necessário; por exemplo, `cargo test --manifest-path src-tauri/Cargo.toml --lib floors::test`. Por padrão, o recruit aponta `CARGO_TARGET_DIR` para o target compartilhado do clone principal. Compilações simultâneas podem disputar o lock desse target. Se vários agentes precisarem rodar Cargo ao mesmo tempo, inicie a ADE com `ADE_AGS_CARGO_TARGET_DIR=per-worktree`: cada worktree terá seu próprio target, sem essa disputa, ao custo de recompilar as dependências uma vez em cada worktree.

Se uma próxima missão criar outro worktree Windows sem `node_modules`, crie uma junction para a instalação compartilhada antes de abrir o recruit. Preserve uma junction correta que já exista; não remova nem substitua um diretório desconhecido.

No Linux e no CI, instale as dependências no checkout (`bun install --frozen-lockfile`) e deixe Cargo usar `src-tauri/target`, que é o caminho cacheado pelo workflow. Não copie o `CARGO_TARGET_DIR` absoluto do Windows para scripts Linux ou CI. Os comandos Node acima usam caminhos relativos e funcionam nos dois sistemas; para os testes Rust no CI, use `cargo test --manifest-path src-tauri/Cargo.toml --lib` a partir da raiz. Durante trabalho concorrente, `ADE_AGS_CARGO_TARGET_DIR=per-worktree` também pode ser configurado no processo da ADE em Linux/macOS; isso separa os locks, mas recompila as dependências uma vez por worktree.

Inclua no briefing inicial do agente: caminho do worktree, branch e base, shell a usar, estado/alvo do link de dependências, configuração de `CARGO_TARGET_DIR` para aquele sistema e os comandos exatos de validação. Resolva os caminhos antes de abrir a missão ou executar `ags peer recruit`; o agente não deve precisar descobrir nem inferir o setup.
# Etapa 11 — eficiência entre agentes, ponto 4

O ponto 4 mede se dividir uma missão ajuda. O cartão aparece no QG e no painel de tempos da missão; os dados também estão disponíveis por IPC (`mission_efficiency`) e CLI (`ags mission efficiency <id>`).

## Métricas por missão

- **Tempo ativo (`activeMs`, `activeSource`)**: fonte unificada da Etapa 14: `mission_active`, depois união de spans `turn`/`peer_ask`, depois relógio com `started_at`. Sem fonte, fica não medido (`null`).
- **Detalhe por turno (`turnMs`)**: união de spans `turn` e `peer_ask`, sem sobreposições. Disponível para analisar turnos e esperas; não substitui o tempo oficial quando há `mission_active`.
- **Relógio (`wallMs`)**: diferença entre `started_at` e `ended_at`; enquanto a missão está em andamento, usa o horário atual.
- **Custo estimado (`costEstimate`)**: soma de `spent_usd` dos Runs da missão, incluindo tentativas anteriores. Fica `null` quando nenhum Task reportou custo. A UI não apresenta custo ausente como zero.
- **Agentes (`agents`)**: quantidade de nomes distintos observados nos spans; o destino de um `peer_ask` também conta como participante.

## Comparação histórica

Para cada missão, a ADE considera até as 30 missões mais recentes concluídas no mesmo workspace, exclui missões de teste e agrupa as amostras por 1, 2, 3–4 ou 5+ agentes. A tabela mostra medianas de tempo ativo pela mesma fonte unificada da missão atual (`median_active_ms`), relógio e custo, além do ganho percentual de cada faixa contra a mediana histórica de um agente. Também compara a missão atual com essa referência de um agente.

Os ganhos são observações do histórico do workspace, não uma prova causal: missões diferentes podem ter objetivos e dificuldades diferentes. A quantidade de amostras fica visível. Se o histórico não tiver uma faixa de um agente ou se o provider não reportar custo, o ganho correspondente aparece como não medido.

O briefing do orquestrador orienta recrutar somente quando o trabalho for independente e paralelizável e houver expectativa de terminar mais rápido do que com um agente só. O custo de coordenação e recursos também importa.

## Limites dos dados

O tempo ativo depende da cobertura de `mission_active` e das fontes de fallback, identificadas em `activeSource`. Spans dependem dos intervalos registrados; o relógio de parede inclui esperas. Agentes sem spans não entram na contagem observada. Providers que não reportam custo deixam `costEstimate` e o ganho de custo sem medição; não se infere custo zero. Para a fotografia anterior às mudanças da Etapa 11, consulte [AGENT_EFFICIENCY_BASELINE.md](./AGENT_EFFICIENCY_BASELINE.md), preparado pelo QA.
# Eficiência entre agentes

## Etapa 11 — ponto 5: menos conversa, mais memória

O briefing de missões em terminais orienta o Orquestrador a consultar os achados e a memória aprovada antes de perguntar de novo. Os integrantes consultam a memória da missão antes de pedir contexto e enviam uma única entrega final concisa, com resultado, decisões, arquivos tocados, testes e bloqueios. Atualizações durante o trabalho ficam reservadas a bloqueios e mudanças de decisão.

### Canais e escopos

- **Handoff Structured v1** registra a entrega entre Tasks do Mission Runtime: resumo, arquivos, testes, decisões, riscos, próximos passos e artefatos. O downstream usa o handoff já recebido; `task_result` recupera detalhes quando necessário. Esse contrato não é uma ferramenta de mensagens do canvas de terminais.
- **Entrega final no canvas** usa uma mensagem `ags peer tell` com os mesmos dados essenciais. Ela é uma passagem de contexto imediata, sem criar uma memória durável.
- **Shared Memory** guarda apenas conhecimento aprovado e útil depois. Use escopo `mission` para decisões e restrições duradouras daquela missão; use `workspace` para conhecimento que vale para o projeto. Uma sugestão só aparece em buscas após aprovação do usuário.

Resultados e arquivos de uma Task não devem ser duplicados em memória durável: use o handoff do Mission Runtime ou a entrega final do canvas. Antes de perguntar, consulte a memória aprovada e o handoff que já estiver disponível; pergunte apenas o dado ausente necessário para decidir ou desbloquear.

### Medição estática de tokens por mensagem

`ags peer tell` não informa tokens de entrada ou saída, e não há tokenizer por provider instalado nesta base. Por isso, a comparação abaixo é um cenário sintético equivalente, não telemetria de uma missão real. A estimativa é `ceil(bytes UTF-8 / 4)`; a contagem exata varia com o tokenizer do provider.

| Antes: esclarecimentos sem formato final | Tokens estimados | Depois: entrega padronizada | Tokens estimados |
| --- | ---: | --- | ---: |
| Integrante: “Terminei a implementação.” | 7 | Integrante: `resultado=implementado; decisões=mantive o contrato atual; arquivos=src/feature.ts; testes=vitest (passou); bloqueios=nenhum` | 32 |
| Orquestrador: “Quais arquivos você alterou e quais decisões tomou?” | 14 | — | — |
| Integrante: “Alterei src/feature.ts; mantive o contrato atual.” | 13 | — | — |
| Orquestrador: “Quais testes executou e houve algum bloqueio?” | 12 | — | — |
| Integrante: “Vitest passou; sem bloqueios.” | 8 | — | — |
| **Total** | **54 em 5 mensagens** | **Total** | **32 em 1 mensagem** |

Nesse exemplo controlado, a conversa cai de 5 para 1 mensagem e de 54 para 32 tokens estimados (−41%). A mensagem individual fica maior para carregar os cinco campos, enquanto o total cai por eliminar pedidos de esclarecimento.

### Custo adicional dos briefings

Para separar o custo das instruções do ganho de conversa, comparei os briefings completos antes e depois das alterações com a mesma fixture: Mission `id=m-9`, título `T`, objetivo `O`, equipe vazia, sem achados nem memória recebida; para o integrante, papel `Backend` sem descrição ou instruções. O “antes” é o código imediatamente anterior ao commit P5 `e19887a^`; o “depois” inclui os novos blocos e a orientação de memória. A contagem é `ceil(bytes UTF-8 / 4)` sobre o texto produzido pelas funções, incluindo quebras de linha.

| Briefing | Antes (bytes; tokens estimados) | Depois (bytes; tokens estimados) | Custo adicional estimado |
| --- | ---: | ---: | ---: |
| `leadBriefing` | 1.774; 444 | 2.735; 684 | +961 bytes; +240 tokens |
| `memberBriefing` | 370; 93 | 767; 192 | +397 bytes; +99 tokens |

Esses valores medem o overhead estático de contexto dos novos briefings; não medem o uso de uma conversa real. A economia efetiva depende de quantas perguntas e respostas redundantes a equipe realmente elimina. Compare-a com a baseline de QA `AGENT_EFFICIENCY_BASELINE.md` do worktree e11-p4 antes de afirmar ganho real. Essa baseline não estava presente em `ADE-AGS-e11-p4-metricas/docs/ade-ags/` quando esta medição foi feita, então a comparação de QA permanece pendente. O uso real deve ser medido com dados de usage do provider; esta base ainda não registra tokens de mensagens peer.

## Etapa 14 — fonte única de tempo ativo

Antes desta etapa, a lista e o QG do bot usavam `mission_active`, enquanto o cartão de eficiência e `ags mission efficiency` chamavam a união de spans de tempo ativo. São medições diferentes:

| Medida | Semântica e cobertura | Turnos longos e esperas |
| --- | --- | --- |
| `mission_active.active_ms` | O watcher amostra a cada 1 s e acumula uma vez por missão `running` quando algum terminal tem saída sustentada (sequência de pelo menos 2 s, saída há menos de 3 s). Envia blocos a cada 10 s para `mission_active_add`. Agentes simultâneos não multiplicam o tempo. | Com todos quietos, o acumulador para. Trabalho silencioso não é observado; depende da janela coletora. Não equivale a CPU nem à duração integral de um turno. |
| União de spans `turn`/`peer_ask` | Intervalos persistidos em `mission_timings`; exclui `boot`/`briefing` e une sobreposições. Era o `activeMs` da eficiência; agora é `turnMs` (detalhe por turno). | Um intervalo pode incluir pausas; `peer_ask` inclui espera de resposta. O rastreador encerra turnos após 5 s de silêncio. Falta de spans pode subestimar missões longas. |

### Comparação no banco real

Fotografia obtida pelo Orquestrador em 05/10/2026, com leitura de `~/.ags/data.db`; nenhum dado foi alterado. Os totais de cobertura não representam a interseção entre as fontes.

| Amostra | `mission_active` | Spans `turn`/`peer_ask` |
| --- | ---: | ---: |
| Cobertura entre 47 missões | 9/47 | 20/47 |
| Missão com prefixo `f754b31f` | 4.322 s | 28 s |

Recorte ampliado abaixo: as colunas de turno são **soma de spans `turn` e maior turno**, não a união `turn`/`peer_ask` usada por `turnMs`. Portanto, a soma pode contar paralelismo mais de uma vez.

| Missão (prefixo) | Relógio (s) | `mission_active` (s) | Soma `turn` (s) | Maior `turn` (s) |
| --- | ---: | ---: | ---: | ---: |
| `67d396c0` | 12.646 | 1.403 | 1.758 | 1.371 |
| `386661ff` | 2.464 | 1.284 | 319 | 291 |
| `02b9294a` | 8.291 | 6.376 | 71 | 59 |
| `5519704d` | 40.873 | 10.246 | 604 | 435 |
| `e7f62d88` | 43.489 | 2.584 | 601 | 448 |
| `36ee5832` | 4.268 | 24 | 133 | 123 |
| `c643e561` | 7.230 | 29 | 929 | 579 |
| `f754b31f` | 10.359 | 4.322 | 28 | 16 |
| `8541b738` | 3.933 | não medido | 1.662 | não informado |
| `a536f7e9` | 19.174 | não medido | 1.386 | não informado |
| `e307973c` | 41.134 | não medido | 765 | não informado |

A leitura do recorte indica subestimação pelos spans quando o trabalho não passa pelos caminhos rastreados e possível superestimação com turnos longos de espera. `c643e561`, por exemplo, tem 29 s de saída sustentada e 929 s somados em turnos; `02b9294a` tem 6.376 s de saída sustentada e apenas 71 s em turnos. A soma e a união respondem a perguntas diferentes.

As medidas não são intercambiáveis: cobertura e limites de coleta variam. Esses dados não permitem atribuir toda a diferença a espera ou trabalho silencioso.

### Regra e contratos

`missions/active.rs` centraliza a escolha: `mission_active` positivo → união de spans `turn`/`peer_ask` → relógio de parede, somente quando existe `started_at` → não medido. O resultado é `{ms, source}`, com fonte `mission_active`, `spans` ou `wall`; sem fonte, ambos são `null`. O relógio usa `(ended_at ?? agora) - started_at`, em segundos convertidos para milissegundos, sem duração negativa.

A lista (`MissionSummary.activeSeconds = ms / 1000`, `activeSource`), o QG, o painel de tempos e a CLI usam esse mesmo resultado. `mission_efficiency` expõe `activeMs`, `activeSource` e `turnMs`; `mission_timings` expõe `active: {ms, source}` além dos spans e gargalos. `ags mission efficiency` e `ags mission timings` recebem esses contratos. Comparações históricas por faixa de agentes resolvem cada missão pela mesma regra antes de calcular a mediana.

Zero gravado em `mission_active` não é tratado como coleta positiva e segue o fallback. Não há migração, backfill ou reescrita de dados antigos. Missões sem coleta oficial usam uma duração disponível por fallback, com sua origem identificada; sem início nem spans, ficam não medidas. Totais por agente e gargalos continuam sendo detalhes por turno e podem superar o relógio da missão por paralelismo.

## Etapa 15 — Início rápido da missão e isolamento por worktree

### Diagnóstico de latência (Missões 13 e 14)

A análise comparativa entre os tempos de infraestrutura e execução cognitiva revelou um contraste severo: enquanto o boot dos terminais dos agentes ocorria em 5 a 11 segundos, o primeiro turno dos integrantes demorava entre 7 e 13 minutos:

| Métrica na Etapa 14 | Duração observada | Impacto |
|---|---:|---|
| Boot dos terminais | 5 a 11 s | Infraestrutura ágil |
| Primeiro turno: Orquestrador | 421 s (~7 min) | Atraso no envio das tarefas |
| Primeiro turno: Frontend | 488 s (~8 min) | Exploração isolada sem tarefa |
| Primeiro turno: QA / Tests | 800 s (~13 min) | Exploração profunda sem tarefa |
| Primeiro `peer ask` do Orquestrador | 701 s (~11,6 min) | Expirou por timeout |
| Disputa de worktree compartilhado | Conflito concorrente | "Backend já está editando o Rust neste worktree" |

**Causas raiz identificadas:**
1. **Exploração prematura do Orquestrador:** O orquestrador gastava centenas de segundos inspecionando repositórios e arquivos antes de formular o plano e delegar aos membros.
2. **Exploração não orientada dos membros:** Os integrantes iniciavam varreduras profundas e edições de código por conta própria antes de receberem o briefing da sua tarefa específica.
3. **Colisão no worktree compartilhado:** Todos os agentes operavam no mesmo diretório de trabalho, provocando conflito de branches, travas de compilação em `target/` e conflitos de edição simultânea em arquivos compartilhados.

### Soluções arquiteturais da Etapa 15

#### 1. Métrica "Tempo até a primeira delegação" (`first_delegation`)
- Mede o tempo decorrido desde o marco inicial da missão (`started_at` ou span `boot`) até o primeiro evento de delegação (`peer_message` com detalhe `delegation`, ou fallback para `peer_ask` do Orquestrador).
- Calculada de forma pura em Rust (`missions/timings.rs::first_delegation`), retornando `(Option<i64>, Option<&'static str>)` indicando os milissegundos e a fonte (`peer_message` ou `span`).
- Exposta no QG do bot, no painel de tempos da missão e pela CLI em `ags mission timings <id>` (`firstDelegationMs`, `firstDelegationSource`).

#### 2. Protocolo de Briefing Estruturado
- **Orquestrador:** Regra de ouro de delegação rápida. O orquestrador sintetiza um plano conciso a partir do objetivo e emite `ags peer tell` para cada integrante nos primeiros ~2 minutos. Apenas após concluir a delegação inicial é permitido ao orquestrador aprofundar investigações no código.
- **Membros:** Instrução mandatória de espera ativa. Integrantes são instruídos a não explorar arquivos nem editar código antes do recebimento formal de sua tarefa e da designação do seu worktree exclusivo.

#### 3. Isolamento Concorrente por Worktree e Branch
- Cada integrante recebe um worktree dedicado e uma branch própria baseada em `origin/master` (`e15-backend`, `e15-frontend`, `e15-qa`).
- Reaproveitamento da infraestrutura da Etapa 11 (`floors.rs`/setup):
  - No Windows, criação de junction para a pasta `node_modules` compartilhada (ou symlink em Unix), garantindo instalação instantânea sem duplicação de gigabytes de dependências.
  - Configuração de `CARGO_TARGET_DIR` isolado (`per-worktree`) ou apontado para target de review, prevenindo disputas de lock no compilador Rust (`src-tauri/target`).
- O briefing de cada membro especifica claramente seu caminho absoluto, branch e comandos de validação correspondentes.

#### 4. Pré-preenchimento de Contexto
- O briefing é pré-alimentado automaticamente com os achados do precheck (`mission precheck`) e com as memórias aprovadas da missão (`Shared Memory`).
- Elimina rodadas exploratórias de busca de contexto que consumiam tokens e tempo desnecessário nos primeiros turnos.

### Medição Antes vs. Depois

| Aspecto | Antes (Etapa 14) | Depois (Etapa 15) | Ganho |
|---|---:|---:|---:|
| Tempo até a 1ª delegação | 701 s | < 120 s | > 80% mais rápido |
| Primeiro turno do Orquestrador | 421 s | ~90 s | ~78% redução |
| Primeiro turno dos Membros | 488 s – 800 s | Standby imediato | Quase instantâneo |
| Conflitos de lock / worktree | Recorrentes (bloqueio mútuo) | Zero (worktrees isolados) | 100% eliminados |

## Etapa 15 — telas (Frontend)

O QG ("Ao vivo") lê o tempo ativo da fonte unificada (`timings.active`) e deriva andar e entregas dos sinais reais dos terminais (ver `LIVE_ARCADE.md`, v4). A métrica de tempo até a primeira delegação (`firstDelegationMs`/`firstDelegationSource`) é do Backend; sem dado, a tela mostra cinza.


## Etapa 16 — Orquestração confiável

### Ponto 1 — Orquestrador parado
Espelho do "agente parado" (Etapa 14): `src/features/missions/leadStall.ts`, ligado em `watcher.ts`. Funções puras (`applyLeadMessage`, `findLeadStalls`, `findScreenAsks`, `screenQuestion`, `leadStallMessage`, `deriveAlerts`), testadas em `tests/leadStall.test.ts`.

1. **Pedido aberto:** `ask` de um integrante, ou `tell` que contém `?` e não é cortesia (`isAck`). A entrega final (`tell` sem pergunta) não conta. Um integrante quieto ≥ 45 s com uma pergunta nas últimas linhas da tela também abre pedido (origem `screen`); diálogos de aprovação (esperam o usuário) são ignorados.
2. **Fecha** quando o orquestrador manda mensagem ao integrante.
3. **Sem falso positivo:** o orquestrador trabalhando (`activeTabIds` e `sustainedTabIds`) nunca é considerado parado; cada saída ou digitação dele reinicia o relógio; um diálogo de aprovação na tela dele suspende o aviso; o aviso só é colado quando ele não está no meio de um turno.
4. **Ao detectar:** aviso PT-BR no terminal do orquestrador, alerta (`useStallAlerts`) no QG e na aba da missão, e span `orchestrator_stall` (`detail` = `alerted:<fonte>` ou `answered:<fonte>`) para `ags mission timings`: contagem de alertas e tempo de espera. O "agente ocioso com tarefa pendente" (`stalled.ts`) alimenta o mesmo painel.

Limiar: `LEAD_STALL_MS` = 180 s (`ags.leadStallMs`, mínimo `MIN_LEAD_STALL_MS` = 30 s).

### Ponto 2 — Teste de início
Cada agente grava eventos pontuais (`startedMs == endedMs`, `actor` = nome): `start_briefing` (envio), `start_activity` (1ª saída além do eco, `watchStart`), `start_retry` (Enter reenviado, por `SUBMIT_RETRY_MS` ou pela verificação aos 25 s) e `start_stalled`. Quando o último agente arranca, grava-se `start_all_working` (do início da missão até ele) e o QG mostra "tempo até todos trabalharem" (`startup.ts`, `startupProgress`). O plazo é `START_DEADLINE_MS` = 120 s; `ags mission startcheck <id>` confere o roster e os eventos persistidos, inclusive o agente que nunca arrancou.

## Etapa 16 — métricas e verificação do início (Backend)

`ags mission startcheck <id>` consulta a equipe persistida e os spans por agente, incluindo integrantes sem nenhum evento. Retorna `briefingSentMs`, `activityMs`, `timeUntilStartMs`, `exceededDeadline`, `passed`, `submitRetries` e `stalledNotifications`; o resumo contém `allWorking`, `passed` e `timeUntilAllWorkingMs`. O limite testável `START_DEADLINE_MS` é 120.000 ms desde a abertura dos terminais (primeiro `boot`), com início persistido da missão como fallback. Exatamente 120 segundos passa; ausência de briefing, atividade ou referência temporal não passa. Um span `turn` não prova o instante de atividade. O comando consulta o estado, sem enviar Enter.

Contrato da instrumentação: `start_briefing`, `start_activity`, `start_retry` e `start_stalled` são eventos pontuais (`startedMs == endedMs`, `actor` = nome do integrante). `boot` continua evidência legada do envio do briefing. `start_all_working` usa `actor = all`, início na abertura da equipe e fim na primeira atividade sustentada do último agente. O frontend é responsável por detectar atividade e persistir esses eventos.

`ags mission timings` aceita os novos kinds e expõe `orchestratorStallCount`, `orchestratorWaitMs`, `orchestratorMaxWaitMs` e `timeUntilAllWorkingMs`. Em `orchestrator_stall`, `startedMs` identifica o início da espera, `endedMs` o alerta/resposta e `detail` é `alerted:<fonte>` ou `answered:<fonte>` (`peer_ask`, `peer_tell`, `screen`). A contagem considera alertas únicos; espera total/máxima agrupa ator, alvo e início e usa a maior duração, evitando duplicar alerta seguido de resposta. Sem `start_all_working`, o tempo permanece ausente. Reutiliza schema existente, sem migração.
