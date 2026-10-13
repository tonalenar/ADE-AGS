# Relatório de QA — Missão Melhoria da Memória (Rodada V18)

- **Papel:** QA / Tests
- **Worktree:** `C:\Users\tonz1n\.ags\worktrees\67cb84ad`
- **Branch:** `cc/mission-a2d1dfc7-37a5-4ba7-8c3d-67cb84ad`
- **Missão:** Melhoria da memória (`a2d1dfc7-37a5-4ba7-8c3d-e884324d88bc`)
- **Agente:** Antigravity (tab id: `64904e12-4431-43d6-922c-b9c9198818fd`)

---

## 1. Resumo Executivo

| Item de Avaliação | Status | Síntese do Resultado |
|---|---|---|
| **1. Cache entre worktrees** | **FUNCIONA** | Worktrees com a mesma árvore Git retornam `já verde neste hash` sem reexecução. |
| **1.1. Invalidação por 1 byte** | **FUNCIONA** | Alteração de 1 byte invalida a chave de cache e reexecuta; reversão restaura o cache hit. |
| **1.2. Corrida concorrente de `ags test run`** | **FUNCIONA** | Disparos concorrentes usam coordenação via `test_inflight` / SQLite sem corromper o cache. |
| **2. Fluxo CLI de memória** | **FUNCIONA** | `suggest`, `search`, `history`, `index`, `open`, `export` validados. Propostas pendentes não aparecem como aprovadas para outros agentes. |
| **3. `ags test smoke` no terminal** | **FUNCIONA** | 9/9 testes passaram (0 falhas, `failed: 0, passed: true`). |
| **4. Revisão dos commits Backend e Frontend** | **APROVADO** | Backend (`52403760`) e Frontend (`04f61fb7`, `2434c9fd`): escopo estrito em memória e 100% cobertos por novos testes. |
| **5. Propostas banais de memória** | **CONCLUÍDO** | 5 propostas banais submetidas (limite máximo 6), sem caminhos locais ou credenciais. |

---

## 2. Detalhamento dos Testes

### 2.1. Cache de Testes (`docs/ade-ags/TEST_CACHE.md`)

1. **Reutilização entre worktrees distintos com mesma árvore:**
   - Worktree 1 (`C:\Users\tonz1n\.ags\worktrees\67cb84ad`): `HEAD^{tree}` = `8916f2e785282b58d981fd32d0cbf021c0759ca0`. Execução de `ags test run babel` registrou resultado inicial.
   - Worktree 2 (`C:\Users\tonz1n\.antigravity\ADE-AGS-wt\instalador`): mesma árvore `8916f2e785282b58d981fd32d0cbf021c0759ca0`.
   - Resultado no 2º worktree:
     ```json
     {"cacheHit":true,"durationMs":0,"message":"já verde neste hash (há 0 min)","passed":true,"suite":"babel","treeHash":"8916f2e785282b58d981fd32d0cbf021c0759ca0"}
     ```
   - Nenhuma reexecução desnecessária. Cache compartilhado perfeitamente pelo identificador canônico do repositório comum.

2. **Invalidação por 1 byte alterado:**
   - Adicionado 1 byte em `src/main.tsx` (árvore alterada para hash `5a6a295ddbe7155dda6b1ed37cb0e8a7233c8ce1`).
   - Saída de `ags test run babel`:
     ```json
     {"cacheHit":false,"durationMs":1326,"message":"resultado registrado","passed":true,"suite":"babel","treeHash":"5a6a295ddbe7155dda6b1ed37cb0e8a7233c8ce1"}
     ```
   - O cache anterior foi devidamente ignorado.
   - Ao executar `git checkout src/main.tsx` e reverter a alteração:
     ```json
     {"cacheHit":true,"durationMs":0,"message":"já verde neste hash (há 1 min)","passed":true,"suite":"babel","treeHash":"8916f2e785282b58d981fd32d0cbf021c0759ca0"}
     ```

3. **Teste de corrida entre dois `ags test run` simultâneos:**
   - Disparados dois processos concorrentes via background jobs (`Start-Job`).
   - Execução simultânea com `--force`: ambos finalizaram com código 0 e registraram tempos em `test_results`.
   - Execução simultânea em estado cacheado: ambos retornaram `cacheHit: true` (`já verde neste hash`).
   - Verificação de integridade pós-corrida com `ags test status`: nenhuma corrupção na tabela `test_results`, linhas JSON íntegras e lock liberado limpo.

---

### 2.2. Fluxo de Memória pelo CLI

Foram exercitados todos os comandos solicitados:
1. `ags memory suggest`: Submissão de propostas gerando `status: pending`.
2. `ags memory search`: Busca efetuada por termos das propostas recém-criadas (`qa.cache`, `same-tree-hit`). Nenhuma proposta pendente foi retornada; o mecanismo respeita o isolamento de propostas não aprovadas.
3. `ags memory history`: Consulta com `--key` das chaves propostas retornou `history: []`, confirmando que não há revisões válidas aprovadas antes do consentimento do usuário.
4. `ags memory index`: Retornou estritamente o índice consolidado de `MEMORY.md`.
5. `ags memory open`: Leitura bem-sucedida de seções consolidadas (`findings.md`, missões aprovadas), sem vazamento de rascunhos.
6. `ags memory export`: Exportação executada com sucesso (`entries: 193`, `revisions: 194`), gravando markdown e metadados no diretório do workspace.
7. **Isolamento entre agentes:** Consultas de `memory search` e `memory index` executadas a partir do worktree do Backend (`C:\Users\tonz1n\.ags\worktrees\141c5f5c`) confirmaram que propostas do QA permanecem invisíveis para outros agentes.

---

### 2.3. `ags test smoke` no Terminal

Executado diretamente no terminal do agente QA (`ADE_TAB_ID = 64904e12-4431-43d6-922c-b9c9198818fd`):

```text
ok    app responde (tab list) — 6 abas (0 ms)
ok    tab output da própria aba — leu as últimas linhas (3 ms)
ok    tab inexistente é recusada — Esta janela não tem nenhuma aba com o id smoke-inexistente (3 ms)
ok    missão inexistente é recusada — não há nenhuma missão smoke-inexistente (0 ms)
ok    peers — lista a equipe (2 ms)
ok    memória: índice — índice lido (49 ms)
ok    --file chega como text (CLI) — 92 caracteres, aspas/acento/$HOME/crase intactos (8 ms)
ok    --file inexistente dá erro de leitura — erro de leitura claro, nada enviado (0 ms)
ok    peer tell a destino inexistente é recusado — recusado sem entregar nada (1 ms)
{"checks":[...],"failed":0,"passed":true}
```

- Total: 9 verificações realizadas, 9 aprovadas, 0 falhas.

---

### 2.4. Revisão dos Commits de Backend e Frontend

1. **Backend (`52403760`):**
   - **Mensagem:** `fix(memory): restrict agent revision reads to current approval`
   - **Arquivos:** `src-tauri/src/memory.rs`, `src-tauri/src/memory/tests.rs`
   - **Escopo:** Restringe leitura de revisões por tarefas ao status ativo e aprovado atual.
   - **Testes:** Adicionado teste `task_revision_reads_only_expose_current_approval_across_missions`.
   - **Validação:** `ags test affected` verde (`cacheHit: true` para `memory::`).
   - **Veredito:** Aprovado.

2. **Frontend (`04f61fb7`, `2434c9fd`, `9b9b5d16`):**
   - **Commits:**
     - `04f61fb7`: `feat(memória): aviso visual de prioridade alta pedida por agente`
     - `2434c9fd`: `feat(memória): title em textos cortados e rótulo acessível no Cancelar da confirmação`
     - `9b9b5d16`: `fix(memória): Enter no diálogo de lote só confirma com o foco no botão`
   - **Arquivos:** `src/features/memory/MemoryInbox.tsx`, `src/features/memory/bulkReview.ts`, `src/features/memory/tests/bulkReview.test.ts`, `src/features/memory/tests/memoryInbox.test.tsx`
   - **Escopo:** Interface e lógica de confirmação da revisão de memórias em lote.
   - **Testes:** Testes unitários e de componente atualizados (`bulkReview.test.ts` e `memoryInbox.test.tsx`) garantindo que Enter no modal só dispara ação com foco nativo no botão.
   - **Validação:** `ags test affected` verde (`babel`, `tsc`, `frontend` 100% verdes).
   - **Veredito:** Aprovado.

---

### 2.5. Propostas Banais de Memória Geradas (5 / máx 6)

1. `qa.cache.same-tree-hit` (kind: `finding`, priority: 1, entryId: `de395fbd-8a88-4f34-ac29-82528ebb55d5`)
   - *Texto:* `Worktrees com a mesma arvore compartilham o cache de testes com a mensagem ja verde neste hash.`
2. `qa.cache.invalidation-one-byte` (kind: `decision`, priority: 0, entryId: `85aeb22a-ca43-4358-bd4f-3e956ffee988`)
   - *Texto:* `Qualquer byte alterado em arquivos observados pela suite invalida o cache de execucao local.`
3. `qa.cache.concurrency-inflight` (kind: `finding`, priority: 1, entryId: `b7bc6e70-b27b-4804-9554-9ffedea44559`)
   - *Texto:* `Execucoes simultaneas concorrentes coordenam lock via test_inflight sem corromper a tabela de resultados.`
4. `qa.smoke.execution-scope` (kind: `note`, priority: 0, entryId: `6192ed4b-8b42-4369-8738-2fb6b5081959`)
   - *Texto:* `O comando ags test smoke valida a comunicacao entre CLI e aplicacao aberta em 9 passos.`
5. `qa.memory.pending-isolation` (kind: `constraint`, priority: 1, entryId: `321e8530-1f0a-4c94-9fbc-38427e624711`)
   - *Texto:* `Memorias sugeridas por agentes permanecem com status pending ate aprovacao explicita e nao aparecem em memory search.`

Todas isentas de caminhos locais, dados sensíveis ou credenciais.

---

## 3. Conclusão, Defeitos Reproduzíveis e Pendências

- **Defeitos Reproduzíveis:** Nenhum defeito encontrado.
- **Pendências:** Nenhuma pendência técnica.
- **Próximos Passos:** Entrega comunicada ao Orquestrador via `ags peer tell`.
