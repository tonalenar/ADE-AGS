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
