# Etapa 24: confirmação e contratos do backend

Base conferida: `origin/master` em `4470a6c`, schema v40. Migração aditiva e
idempotente v41 reúne todas as adições desta entrega. Nenhum teste abre o banco
real do usuário. No próximo início da aplicação, uma base antiga ganha backup
SQLite consistente com o WAL antes de migrar (`VACUUM INTO`).

| Achado | Conferência do código anterior | Entrega |
| --- | --- | --- |
| M3 | **confirmado**: `snapshot_run` ordenava por prioridade, até 16 entradas/16 KiB | Índice de até 39 linhas, mais cinco entradas relevantes pelo BM25 ao objetivo do Run; corpos e índice selados. Bytes e estimativa `orchestrator::digest::estimate_tokens` antes/depois. Commit local da projeção, quando o repositório já existe. |
| M1 | **confirmado**: `db_delete_workspace` executava DELETE físico. **não reproduz** perda de revisões aprovadas com o trigger v39: ele aborta a cascata. Workspaces sem revisões ainda perdiam histórico. | Soft-delete, prazo de recuperação de 30 dias, restore explícito. Expiração não dispara cascata automática. Export Markdown + JSON das revisões antes de excluir. |
| M2 | **confirmado**: quota contava corpos rejeitados para sempre e recusava propostas além de 32 pendentes | Compactação explícita de rejeitadas após no mínimo 30 dias; hash/metadados preservados. Aprovadas nunca são compactadas. Quota considera payload de revisões, chaves e arquivo de auditoria. Fila limitada de 256 rascunhos de agente por workspace; promoção ainda resulta em proposta pendente. Fila cheia devolve erro pedindo aviso ao orquestrador. |
| M4 | **confirmado**: normalização não removia acentos/pontuação, e contradição dependia da chave exata | Normalização Unicode; chaves semelhantes com negação/valores diferentes sinalizam possibilidade. Não há aprovação automática. |
| B4 | **confirmado**: o laço interrompia ao encontrar duplicata | `duplicateOf` e `contradicts` independentes; ambos podem aparecer. |
| B3 | **confirmado**: cursor era OFFSET numérico | Cursor JSON opaco, com escopo e posição composta; não desloca páginas após remoção de item anterior. |
| M7/concorrência | **confirmado**: escrita usava transações DEFERRED | IMMEDIATE em proposta, decisão, purge, compactação, notas e criação autônoma de Run. Testes reais com oito threads e dois subprocessos, conexões distintas no mesmo arquivo SQLite temporário. |
| B7 | **confirmado**: subconsultas escalares e busca histórica N+1 | Otimização aplicada depois de medir ganho e comparar resultados. |
| Imutabilidade DELETE | **não reproduz** ausência de proteção: trigger v39 já bloqueava, exceção controlada de purge existia | Mantido, testado também na atualização v40→v41 e na compactação. |
| Espera instável | **confirmado**: um único `Condvar.wait_timeout` voltava mesmo com fila vazia após wake | `wait_timeout_while` reavalia o predicado até o prazo. `fresh()` já serializava os testes. Regressão injeta cinco notificações sem eventos; mantém `elapsed >= 45 ms` para espera de 50 ms. A/B com código antigo falhou nesta asserção; correção restaurada. Não foi instrumentado o produtor exato do despertar espontâneo na falha original. |

`AGENTS.generated.md` é uma projeção separada exportada dentro do repositório de
memória. O usuário pode referenciá-la explicitamente. Os arquivos do projeto
`CLAUDE.md` e `AGENTS.md` não são alterados.

## Contratos para integração

Comandos Tauri usam argumentos camelCase:

- `memory_context_metrics({runId?, missionId?})`: exatamente um identificador.
  Run retorna `{runId,beforeBytes,afterBytes,tokensBefore,tokensAfter,commit,
  entriesUsed,tokenMethod}`. Mission retorna `{runs:[...]}`.
- `memory_index({workspaceId,missionId?})`: texto delimitado UNTRUSTED DATA.
- `memory_query({workspaceId,missionId?,cursor?,limit?,filter:{query?,kind?,
  status?,used?}})`: `MemoryPage`, com cursor opaco. Estados: `active`, `inactive`,
  `deleted`; `kind` mantém os tipos existentes.
- `MemoryEntry` acrescenta `lastVerified`, `ttlDays`, `timesUsed`. `timesUsed`
  conta Runs que selecionaram a entrada para o snapshot, não prova que o modelo
  a utilizou no raciocínio.
- `memory_export({workspaceId})`: `{path,entries,revisions,deletedAt,deleteAfter}`.
  `memory_workspace_stats({workspaceId})`: mesmas contagens sem `path`.
- `db_delete_workspace({workspaceId})`: soft-delete; `db_restore_workspace`:
  restauração explícita. Prazo de 30 dias é metadado, sem purge automático.
- `memory_agent_drafts({workspaceId})`: array com `{id,scope,missionId,proposal,
  actorKind,createdAt,status:"agent_draft"}`; `proposal` é JSON em string.
- `memory_promote_draft({workspaceId,draftId})`: `ProposalResult`, ainda pendente.
  `memory_discard_draft`: mesmos argumentos, retorna void.
- `memory_compact({retentionDays})`: quantidade compactada; mínimo de 30 dias.
- `memory_verify_source({entryId,filePath?,commit?})`: verifica existência de
  Run/Task e, opcionalmente, arquivo relativo e commit no repositório da fonte.
  Retorna `runExists`, `taskExists`, `fileExists`, `commitExists`,
  `lastVerifiedChanged:false`. Não escreve verificação nem lê conteúdo do arquivo.
- `memory_set_verification({entryId,lastVerified?,ttlDays?})`: metadados opcionais
  definidos pelo usuário.

CLI/IPC de agente:

- `ags memory index` / `ags memory open <caminho>` → `{path,text}`. Projeção virtual
  da memória aprovada, derivada da tab/missão, sem importar edições manuais nem
  abrir arquivos arbitrários. Categorias `.md` e página da própria missão.
  Tabs fora de missão leem apenas o workspace da tab aberta.
- `ags swarm note|question <texto>` → `{id,status:"run_data",projectionError}`.
  Corpo de até 4 KiB, total de 64 KiB por missão; filtro de segredos no núcleo.
  Projeta para `swarms/<slug-da-missão>/findings.md` ou `questions.md`, com envelope.
  Notas não entram em memória aprovada; promoção exige proposta/revisão do usuário.
- Fleet: `memory_search(query,limit?)`, `memory_open(entry_id,revision?)`.
  Só conteúdo aprovado no workspace/missão derivados da Task, sem owner recebido
  do agente, com envelope UNTRUSTED. Aliases existentes continuam disponíveis.
- `ags mission efficiency` acrescenta `memoryContext.runs` com as métricas acima.

## Evidência de desempenho

Fixture controlada: 16 entradas grandes sem relação com a tarefa e uma entrada
relevante sobre SQLite. Os valores finais são impressos pelo teste
`relevance_avoids_unrelated_priority_dump_and_measures_sealed_cost`; tokens são
estimados por caracteres/4, não tokens faturados pelo provedor.

Medição prévia das consultas com equivalência dos resultados:

- `ENTRY_SELECT`, 128 entradas × 40: 92,88 ms → 38,51 ms com joins (~58,5%).
- `load_docs_at`, 128 entradas × 20: 258,19 ms → 19,83 ms em consulta em lote
  com janela (~92,3%).

Os testes não impõem limites de tempo dessas medições. A equivalência, os limites
de contexto, o isolamento, a retenção de dados e a concorrência são as asserções.
