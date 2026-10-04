# Tokens e custo por missão

O detalhe da missão (`MissionsPage.tsx`, seção "Tempos") já mostrava o gasto do ledger da
frota, mas não quantos tokens os terminais da missão consumiram. Esta etapa adiciona um bloco
"Tokens" com o que der pra medir de verdade — sem estimar nada.

## O que é medido

Só Claude Code escreve, em disco, o `usage` exato que a API devolveu pra cada mensagem do
assistente (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`). Esse dado vive nos transcripts JSONL em
`<config_dir>/projects/<slug-do-cwd>/*.jsonl` — o mesmo arquivo que `usage/claude.rs` já lê pra
medir consumo por janela de conta.

`src-tauri/src/usage/mission.rs` faz a mesma leitura, mas recortada por MISSÃO em vez de por
janela de tempo fixa:

- `project_slug(cwd)` reconstrói o nome da pasta de projeto que o Claude Code usa (cada
  caractere fora de `[A-Za-z0-9-]` vira `-`), pra achar só os transcripts da pasta (cwd) da
  missão — nunca os de outro projeto.
- `claude_config_dirs` enumera `~/.claude` mais o `dir` de cada linha de `agent_accounts` com
  `agent_id = 'claude-code'`: uma missão pode ter usado várias contas (pool).
- `read_transcript_usage` lê linha a linha, ignora o que não tem `usage`, e descarta qualquer
  linha cujo campo `cwd` do próprio transcript seja de outra pasta.
- `sum_usage_in_range(records, started_at, ended_at ?? agora)` soma só o que caiu dentro do
  intervalo real da missão (campo `started_at`/`ended_at` de `missions`).

O comando Tauri `mission_tokens(missionId)` devolve isso por agente: tokens medidos
(`input`/`output`/`cacheWrite`/`cacheRead`) e o custo que o ledger da frota reportou
(`usage_events.cost_usd`, somado por `agent_id` dentro dos runs da missão), mais um
`measured: boolean`.

## O que NÃO é medido

Codex, Antigravity, Gemini e OpenCode não escrevem o `usage` exato em disco — não existe
leitor pra eles. Pra esses agentes o comando devolve `measured: false` e os campos de token como
`null` (nunca `0`): a UI mostra "não medido" em cada célula vazia. Mostrar zero seria dizer "não
gastou nada", que é diferente de "não dá pra saber".

O custo do ledger (quando o agente reporta, como Claude Code e OpenCode) aparece mesmo sem
tokens medidos — é um dado independente, já existente, que não depende do transcript.

## Por que não existe um número de "tokens economizados"

Não há, em nenhum lugar, uma medida real de quanto o cache evitou gastar: isso dependeria de
saber o que teria sido enviado SEM cache, e esse contrafactual não existe. Inventar um número
aqui seria pior do que não mostrar nada.

O que É medido, e por isso aparece, é a fração do que foi lido de cache: `cacheRead / (input +
cacheRead + cacheWrite)`, rotulada "lido do cache" — um fato sobre o tráfego que de fato
aconteceu, não uma estimativa de economia.

## UI

`MissionTokensPanel.tsx` (seção "Tokens", ao lado de "Tempos" no detalhe da missão): uma linha
por agente com entrada/saída/cache escrito/cache lido/custo, uma linha de total, e "não medido"
em cada célula sem dado. Atualiza ao abrir o detalhe e a cada 60 s enquanto a missão roda.
Números grandes são compactados (`formatCompactNumber`, ex.: "12,3 mil", "4,5 mi") — o mesmo
padrão de `formatDuration` em `timings.ts`, sem variar por idioma da interface.
