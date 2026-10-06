# Tokens e custo por missão

O detalhe da missão (`MissionsPage.tsx`, seção "Tempos") já mostrava o gasto do ledger da
frota, mas não quantos tokens os terminais da missão consumiram. Esta etapa adiciona um bloco
"Tokens" com o que der pra medir de verdade — sem estimar nada.

## Uso por terminal

Claude e Codex possuem leitores de transcripts. A identidade de cada terminal, a conta e a sessao sao preservadas em `mission_usage_tabs`; o cwd isolado serve apenas como fallback comprovado. `agents[].tabs` e a fonte dos totais de cada agente e da missao. Headless usa o ledger por tarefa. Formatos desconhecidos ficam sem medicao, com campos `null`.

Contrato, regras de deduplicacao e limites historicos: [TAB_USAGE.md](./TAB_USAGE.md).

## Custo estimado e economia do cache

Os tokens são medidos; o dinheiro é **estimado** com o preço de lista da API
(`usage/pricing.rs`, por família de modelo; o modelo vem do próprio transcript):

- **Custo estimado** = entrada + saída + escrita de cache (1,25× a entrada) + leitura de cache (0,1×).
- **Economia do cache** = tokens lidos do cache × (preço de entrada − preço de leitura). É uma
  definição fixa e reproduzível: "quanto custaria ler esses tokens como entrada normal".
- Uma assinatura (Claude Max, etc.) não paga por token: os valores são uma estimativa de
  quanto o uso valeria na API, e a UI diz isso.
- Modelo que a tabela não conhece **não é valorado** (nunca se inventa um preço): fica fora do
  custo e a UI lista "sem preço na tabela". Agentes sem leitor continuam "não medido".

## Tempo ativo da missão

A fonte oficial é `mission_active`: o watcher acumula uma vez por missão `running` quando há saída **sustentada** em algum terminal (pelo menos 2 s de sequência e saída recente, há menos de 3 s). Amostra a cada 1 s e envia blocos a `mission_active_add` a cada 10 s. Com todos quietos, o acumulador para; trabalho silencioso não é observado. Agentes em paralelo não multiplicam a duração.

A escolha é única no Rust (`missions/active.rs`): `mission_active` positivo → união de spans `turn`/`peer_ask` → relógio de parede, somente com `started_at` → não medido. O relógio usa o fim registrado ou o horário atual. `source` identifica `mission_active`, `spans` ou `wall`; sem fonte, duração e origem ficam `null`. Não há migração nem alteração de dados antigos.

Lista, QG, painel de tempos e CLI usam a mesma duração: `MissionSummary.activeSeconds` é `ms / 1000`, com `activeSource`; `mission_efficiency` retorna `activeMs`/`activeSource` e `mission_timings` retorna `active: {ms, source}`. A comparação histórica de eficiência também usa essa regra.

A união de spans permanece em `turnMs`, rotulada **detalhe por turno**: inclui espera de `peer_ask` e possíveis pausas dentro dos intervalos. Não é uma segunda medida oficial quando há `mission_active`. Cobertura real e diferenças estão documentadas em [AGENT_EFFICIENCY.md](./AGENT_EFFICIENCY.md#etapa-14--fonte-única-de-tempo-ativo).

## UI

`MissionTokensPanel.tsx` (seção "Tokens", ao lado de "Tempos" no detalhe da missão): uma linha
por agente com entrada/saída/cache escrito/cache lido/custo, uma linha de total, e "não medido"
em cada célula sem dado. Atualiza ao abrir o detalhe e a cada 60 s enquanto a missão roda.
Números grandes são compactados (`formatCompactNumber`, ex.: "12,3 mil", "4,5 mi") — o mesmo
padrão de `formatDuration` em `timings.ts`, sem variar por idioma da interface.

## Etapa 21 — teto de orçamento e limites de plano

`mission_budget({missionId})` retorna o contrato camelCase de `budgetTypes.ts`: `level`,
`budgetUsd`, `costUsd`, `pct`, `unpricedModels`, `unmeasuredAgents`, `continueAnyway` e
`trendUsdPerHour`. A fonte de custo é a soma das estimativas por aba/tarefa com **tokens
medidos**, não o valor monetário reportado pelo ledger. Modelos sem preço entram na lista
de avisos e ficam fora do custo. Tarefas headless usam os tokens e o modelo do próprio
ledger; sem cache discriminado, não se atribui economia de cache.

O guarda puro (`usage/budget.rs`) retorna `ok`, `warning` a partir de 80%, e `exceeded`
a partir de 100%. Teto `null` significa sem teto; teto zero/negativo exige confirmação.
Uso ausente continua não medido. A tendência usa a diferença de custo entre observações
reais e o tempo decorrido; não prevê tokens de uma tarefa futura. Sem duas observações
válidas, a tendência é `null`.

Ao estourar, `peer recruit`, início/reinício de missão e despacho de uma nova tarefa
param antes de criar processos/worktrees novos. O recruit e o despacho headless usam
a pergunta ao usuário já existente; a UI de missão recebe
`missions.budget.confirmationRequired` e abre o diálogo de orçamento. Só a decisão do
usuário libera o gasto: pode elevar o teto ou continuar. Não existe flag de CLI/MCP que
autorize o agente a ignorar o teto. `mission_raise_budget` e `mission_budget_continue`
são comandos Tauri da UI, ausentes do dispatch IPC/MCP. As decisões e os valores
observados ficam registrados em `settings`, com timestamp/UUID, sem migração de schema.
Continuar vale para a missão; elevar o teto pela UI limpa essa autorização.

O aviso `[AGS] orçamento a 80%...` aparece como **saída** no terminal da orquestradora,
sem inserir texto na entrada da TUI. É deduplicado por missão/teto/nível e sobrevive ao
reinício. `ags mission efficiency` inclui `budget`. O evento `cc-budget-changed` informa
`{missionId}`. Agentes já em andamento não são interrompidos pelo guarda.

### Evidência dos formatos locais

- Claude Code: `projects/<cwd-normalizado>/*.jsonl`, `message.usage`, como antes.
- Codex: `sessions/**/*.jsonl`, eventos `token_count`; deltas cumulativos e sessões são
  deduplicados. `payload.rate_limits.primary/secondary` observados nos arquivos reais
  expõem `used_percent`, `window_minutes` e `resets_at` (300 minutos / 10080 minutos).
- OpenCode: `<XDG_DATA_HOME>/opencode/opencode.db` (padrão `~/.local/share`), ou
  `<perfil-isolado>/opencode/opencode.db` para contas da app.
  Tabelas reais `message`/`session`: mensagem assistant concluída, `tokens.input`,
  `tokens.output`, `tokens.cache.read/write`, `modelID`, `path.cwd`, `session_id` e
  `time_created`. Leitura SQLite somente leitura, timeout zero; falha/schema diferente
  devolve não medido. Placeholders com todos os tokens zero não comprovam medição.
- Antigravity: conversas locais são SQLite, mas `steps`, `gen_metadata` e metadados de
  trajetória armazenam blobs binários. Não foi identificado um campo de tokens com
  contrato legível; fica **não medido**. Não se decodifica protobuf por adivinhação.
- Gemini CLI: não havia executável/transcritos Gemini CLI com tokens observáveis neste
  ambiente; fica **não medido** até existir evidência verificável do formato.

`plan_limits()` lê somente arquivos estruturados do Codex, separando os perfis das
contas, e retorna as janelas 5h/semanal, reset ISO e `observedAt` da última amostra.
Janelas vencidas deixam de ser mostradas. Claude não expõe limite semanal em transcript
local estruturado comprovado: `measured:false`; este caminho não chama `/usage`, não
raspa telas nem faz pedidos de rede. Limites ≥80% de contas com terminais ativos de uma
missão geram aviso deduplicado no terminal da orquestradora. A amostra é a última que a
CLI gravou, não uma consulta em tempo real ao provedor.

Testes Rust cobrem fronteiras 80/100%, teto ausente/zero, tendência, aviso deduplicado,
bloqueio antes da autorização, leitor SQLite do OpenCode e expiração de janelas Codex.
