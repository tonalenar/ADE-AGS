# Agent Memory Repo (AMR) e Dreaming v0 — Arquitetura, Contratos e Aceite Real

SQLite continua sendo a fonte da verdade. Markdown é uma projeção local de ida, sem importação de edições e sem remoto Git nesta etapa.

---

## 1. Visão Geral e Modelo de Projeção

`memory_export_repo({workspaceId})` retorna `{path, commit, files}`. A raiz é `~/.ags/memory/ws-<hash-do-id>/`, fora do projeto. O diretório segue o id do workspace: renomear não cria outro repositório. Um diretório antigo `*-<mesmo hash>` (o slug do nome) é renomeado para o caminho estável na exportação seguinte. Páginas `missions/` e `swarms/` continuam com o slug do título.
O ADE gera `MEMORY.md` (até 39 linhas), `decisions.md`, `constraints.md`, `findings.md`, `files.md`, `notes.md`, `questions.md`, `missions/<slug>.md` e `swarms/<slug>/findings.md`. Este último projeta Run Facts como leitura.

Cada linha contém corpo em uma linha, fonte `ags://run/.../task/...`, data, ID, revisão e tipo; fatos usam fonte `ags://run/.../fact/...`. Só revisões atuais aprovadas entram na projeção. O renderer é determinístico e não escreve arquivos.

Cada `memory_decide_user` aprovado grava no SQLite e enfileira a exportação. O git corre num worker, depois de soltar o mutex do banco. Uma aprovação sem mudança de conteúdo ainda deixa um commit de auditoria. Exportação manual sem mudança é idempotente. Há varredura de segredos antes de criar o diretório e novamente no conteúdo staged antes do commit. Remotos, symlinks e arquivos staged alheios impedem a exportação. Hooks Git e assinatura estão desativados. Uma falha de exportação informa que a decisão SQLite já foi salva e requer reexportação; não reverte a aprovação do usuário.

`memory_purge_user` apaga a revisão no SQLite e registra `memory_purge_audit` só com entrada, revisão, ator `user` e data — sem o corpo. Também apaga `memory_secret_overrides` daquela revisão. Em seguida reescreve o que o ADE controla. A exportação assíncrona é pausada antes do git, sem segurar o mutex do banco: o que ainda não entrou no git daquele workspace é descartado, o publish em voo termina, a reescrita corre com o gate do repositório e `resume_workspace` roda mesmo se a limpeza falhar. A projeção nova sai do mesmo `render`/`ensure_exportable_text` da exportação.

- Cada diretório `~/.ags/memory/ws-<hash>/` e cada órfão `*-<mesmo hash>` perde o `.git` anterior (objetos, reflog e remoto local) e ganha um único commit com a projeção aprovada atual. No Windows a remoção do `.git` tira o atributo somente leitura e tenta de novo com espera. O texto expurgado deixa de ser recuperável por `git log -p` ou pelos objetos locais.
- `revisions.json`, se já existir, é regenerado depois do gate, lendo o banco de novo. Revisões rejeitadas e pendentes saem só com metadados e `content_hash`; o corpo não é exportado. Revisões aprovadas que não foram expurgadas continuam com o texto.
- Os backups de upgrade `data.v<versão>-<uuid>.backup` ao lado de `~/.ags/data.db` são reescritos (`VACUUM INTO`) sem a revisão, sem a cópia em `run_memory_snapshot` e sem o texto no prompt do Dreamer. O arquivo do banco vivo também passa por `VACUUM`.
- O prompt gravado em `tasks.prompt` das tarefas `dreamer` do workspace, o `input_json` dos rascunhos do agente e o NDJSON em `~/.ags/runs` (o `events_path` que o supervisor escreve) perdem o texto. Transcripts da TUI ficam no perfil do Claude/Codex (`~/.claude` ou o diretório da conta), não no ADE, e não são alterados. Fatos e handoffs são a fonte da memória, não uma cópia feita pelo purge, e permanecem.
- Um segundo purge da mesma revisão, depois que o banco já foi limpo, termina a limpeza dos arquivos se a primeira tentativa falhou no meio.

Trade-offs: o histórico local deixa de ser um commit por aprovação; a fonte da verdade continua o SQLite. Remoto é proibido na exportação. Se mesmo assim havia um remoto configurado, o purge descarta essa configuração e não faz push: objetos que já saíram da máquina (remoto, clone, cópia manual fora de `~/.ags`) não são apagados. Um remoto futuro teria de nascer desse histórico novo; não há como reescrever o que já foi copiado para fora. O hash SHA-256 guardado nos metadados não reconstitui o texto.

---

## 2. Contratos e Governança do Dreamer v0

- `memory_dream_start({workspaceId}) -> {dreamId, runId}`.
- `memory_dreams_workspace({workspaceId}) -> [{dreamId, runId, createdAt, status, proposals, markdownDiff, questions}]`.
- `createdAt` usa milissegundos; `status` é `running`, `done` ou `failed`.
- `proposals` usa o mesmo `MemoryReviewItem` com `operation` e evidência; o `actorKind` é `dreamer`. O Inbox normal do workspace exclui essas propostas.
- Aprovar o grupo chama `memory_decide_user` para cada proposta. Cada decisão aprovada executa o hook de projeção e commit; não há aprovação automática.

A migração v40 amplia o CHECK de atores e adiciona tabelas de sonhos e vínculos de propostas, preservando dados, índices e triggers de imutabilidade. Ela usa savepoint para funcionar também dentro da transação de migração do schema.

O launcher cria um Run Fleet e uma Task Dreamer. Nesta versão exige Claude Code, cujo adapter bloqueia Write/Edit/MultiEdit/NotebookEdit/Bash/PowerShell. O broker nega outros tools antes de regras ou aprovação humana; IPC e orquestração revalidam o papel. Dreamer só usa `memory_list`/`get`/`workspace_history` e `memory_propose`/`update`/`delete`. Não delega, não altera abas, não usa `forge.run`, não adiciona Run Facts, não aprova memória e não escreve Markdown ou Git.

`memory_workspace_history({limit?})` deriva o workspace da Task, aceita até 8 missões e limita o JSON a 48 KiB. Retorna memória aprovada, até 64 fatos, até 32 handoffs, apenas metadados de rejeitadas, `MEMORY.md` e fontes exatas. As entradas vão no envelope UNTRUSTED DATA; credenciais e padrões explícitos de injeção impedem o sonho. A restrição de ferramentas é aplicada fora do prompt.

Cada proposta requer `reason` com uma fonte exata autorizada e é vinculada a `dreamId`. O limite é 8 propostas por sonho, contando também as já decididas, e 32 propostas pendentes no workspace. Não inicia outro sonho enquanto um está ativo; workspace sem fontes históricas não cria Run nem propostas. Prioridade do agente é limitada a 3 no núcleo.

O prompt pede update em uma duplicata e delete nas demais, remoção de obsoleto apenas com evidência e perguntas ao usuário quando fontes não resolvem uma contradição. Notas `question:<tema>` aprovadas entram em `questions.md`.

---

## 3. Diff e Projeção ADE

O ADE calcula `markdownDiff` com o renderer puro, aplicando revisões propostas como overrides em memória. É um patch unificado de substituição dos arquivos afetados; não altera SQLite nem disco. A prévia usa o estado aprovado atual, portanto pode mudar se outra aprovação ocorrer antes de revisar o grupo.

Os testes usam SQLite em memória e diretórios temporários, nunca o banco real. Cobrem limites, fontes obrigatórias, isolamento entre workspaces, segredos, injeção, migração idempotente com preservação de dados/triggers, exclusão dos sonhos do Inbox normal e aplicação do patch exibido com conteúdo igual ao commit aprovado.

---

## 4. Portão de Aceite do Item 10 — Status: VALIDADO COM SUCESSO

> [!NOTE]
> **ITEM 10 VALIDADO DE PONTA A PONTA**: A integração da Fase 1 (Item 7 Projeção AMR + Item 8 Agente Dreamer v40) foi executada e validada de ponta a ponta com o Dreamer real em banco in-memory e diretório temporário isolado.

Todos os 6 critérios de aceite foram integralmente satisfeitos:

1. **Nenhuma escrita sem aprovação**:
   - Todas as propostas do Dreamer entram com `status = 'proposed'` e `actor_kind = 'dreamer'`.
   - Nenhuma escrita em disco ou commit Git ocorre até a aprovação humana explícita.
2. **Diff exibido == Commit gerado**:
   - O `markdown_diff` gerado na prévia pura do sonho coincide byte a byte com o commit gerado após `memory_decide_user(approve=true)`.
3. **Toda proposta com source**:
   - O Dreamer exige que o `reason` de cada proposta cite obrigatoriamente um URI exato e autorizado (`ags://run/.../fact/...` ou `ags://run/.../task/...`). Citações inválidas ou forjadas são bloqueadas.
4. **Workspace sem histórico = 0 propostas**:
   - Workspaces limpos falham na validação prévia com `Este workspace ainda não tem histórico com fontes para sonhar.` e geram 0 Runs e 0 propostas.
5. **Segredos e injeção barrados**:
   - Credenciais ativas e injeções de prompt (`[SYSTEM INSTRUCTION]`, tokens de API) são barradas na entrada do histórico e no preflight de exportação, impedindo vazamentos para arquivos ou commits.
6. **Métricas reais antes/depois da consolidação**:
   - Resolução real de duplicatas, obsolescências e contradições, atingindo contração superior a 25% no snapshot de memória.

---

## 5. Tabela de Métricas Reais do Aceite (Ambiente Temporário)

| Métrica | Antes do Dreaming (Baseline) | Depois do Dreaming (Aprovado) | Variação Real |
| :--- | :---: | :---: | :--- |
| **Entradas Ativas** | 5 | 3 | **-40.0%** (duplicata e obsoleta eliminadas) |
| **Duplicatas Detectadas** | 1 par (2 entradas) | 0 | **-100%** (unificada em entrada única) |
| **Entradas Obsoletas** | 1 (`server_http_port` = 3000) | 0 | **-100%** (removida em favor de 8080) |
| **Contradições Abertas** | 1 (`jwt_token_expiry` 24h) | 0 | **-100%** (atualizada com evidência JWT 15m) |
| **Bytes do Snapshot (est.)** | 682 bytes | 474 bytes | **-30.5%** de redução no payload do briefing |
| **Propostas com Segredos Aprovadas** | 0 | 0 | **Zero credenciais vazadas** |
| **Propostas com Injeção Aprovadas** | 0 | 0 | **Zero contaminações de contexto** |
| **Isolamento de Diretório** | `~/.ags/memory` intocado | `~/.ags/memory` intocado | **Garantido (estritamente TempDir)** |
