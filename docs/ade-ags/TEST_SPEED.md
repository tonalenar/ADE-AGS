# Medições e Otimização de Velocidade de Testes (Etapa 22)

Este documento registra as medições empíricas de tempo de execução, a transição do regime anterior para o novo modelo de feedback contínuo ("QA em fluxo"), o impacto do alvo compartilhado do Cargo (`~/.ags/cargo-target-agents`), o comportamento de contenção de lock, a análise de *sccache*, e as regras operacionais que regem a execução de testes locais e no CI.

---

## 1. Tempos Medidos por Ferramenta e Suíte

Todas as medições foram executadas no ambiente Windows com o repositório ADE AGS:

| Ferramenta / Suíte | Comando | Tempo Medido | Observações |
|---|---|---|---|
| **TypeScript (tsc)** | `node node_modules/typescript/bin/tsc --noEmit` | **15s** | Checagem global de tipos de todo o frontend |
| **Vitest (Full Suite)** | `node node_modules/vitest/vitest.mjs run` | **14s** | Execução de todas as suítes de testes unitários frontend |
| **Vitest (--changed)** | `node node_modules/vitest/vitest.mjs run --changed` | **4s** | Execução apenas dos testes de arquivos modificados |
| **Babel Parse Check** | `node scripts/babel-parse-check.mjs src` | **1s** | Validação sintática rápida de componentes e módulos |
| **CI (GitHub Actions)** | `gh pr checks <n> --watch` | **3m – 4min** | Pipeline completo em esteira remota (tsc, vitest, cargo test, lint) |
| **Cargo Test (Cold Build)** | `cargo test --lib --no-run` (target limpo) | **204,63s** (~3m 25s) | Compilação inicial de 519 crates dependentes do zero |
| **Cargo Test (Warm Re-link)** | `cargo test --lib --no-run` (target compartilhado) | **14,55s** | Re-linkagem e re-verificação incremental com alvo aquecido |
| **Cargo Test (Warm Crate Recompile)** | `cargo test --lib` (alteração em arquivo da crate) | **64,7s** | Recompilação apenas da crate `ade-ags`, mantendo dependências prontas |
| **Cargo Test (Warm Unchanged)** | `cargo test --lib` (sem alterações no código) | **1,08s** | No-op incremental com alvo compartilhado aquecido |
| **Cargo Lock Contention (4 jobs)** | 4 execuções concorrentes com target compartilhado | **15,9s – 16,4s** | Bloqueio serializado ordenadamente via lockfile do Cargo sem corrupção |

### Nota sobre Sccache
Foi avaliada a utilização do `sccache` como camada adicional de cache de compilação. No ambiente local:
- O binário `sccache` não se encontra no `PATH`/`bin`.
- A invocação de `cargo install --list` é restrita por permissões/ACL em `.cargo/.crates.toml`.
- Conforme as diretrizes de governança, o agente não deve forçar instalações globais no ambiente do usuário.
- O uso do diretório compartilhado `~/.ags/cargo-target-agents` (via variável `ADE_AGS_CARGO_TARGET_DIR`) atendeu plenamente à meta de redução de tempo, eliminando a penalidade de 204s para 1s–14s.

---

## 2. Comparativo dos Regimes: Antigo vs. Novo

### Regime Antigo (Suíte Completa e Isolamento Extremo)
- **Compilação Rust:** Cada novo worktree recebia um `CARGO_TARGET_DIR` isolado (`per-worktree`). Isso forçava uma compilação fria completa de 519 crates (204,63 segundos) para cada agente ou novo worktree de missão.
- **Execução de Testes:** A cada pequena entrega, executava-se toda a suíte de ponta a ponta (`tsc` 15s + `vitest` 14s + `cargo test` ~204s frio ou 65s morno).
- **Redundância:** Ausência de cache de resultados locais. Um commit sem alterações de código repetia dezenas de segundos de testes já verdes.
- **Gargalo no QA:** O QA ficava ocioso durante quase toda a missão ("espera do QA"), recebendo um lote massivo apenas ao final, gerando atraso concentrado de validação.

### Regime Novo (Testes Afetados, Target Compartilhado e Cache)
- **Target Compartilhado:** Worktrees de missão herdam `ADE_AGS_CARGO_TARGET_DIR` apontando para `~/.ags/cargo-target-agents`. Novos worktrees não recompilam as 519 dependências, caindo de 204s para 14s (ou 1s para alvos inalterados).
- **Mapeamento de Afetados (`ags test affected`):** O planner identifica arquivos tocados desde `origin/master` mais alterações não commitadas e aciona apenas os passos relevantes.
- **Cache de Resultados (`test_results` em SQLite):** Resultados de árvores limpas (`HEAD^{tree}`) são persistidos. Re-execuções sem modificação retornam imediatamente com *cache hit* em 0ms.
- **QA em Fluxo:** O QA valida de forma contínua cada entrega assim que ela chega via `ags peer tell`. O orquestrador notifica o QA a cada entrega recebida.
- **Validação Final:** Apenas **UMA** execução completa ao final da integração (ou delegação ao CI via `gh pr checks <n> --watch`, sem scripts com *sleep polling*).

---

## 3. Tarefas de Referência: Análise Antes vs. Depois

### Caso 1: Mudança Exclusiva de Frontend
*Cenário: Alteração em componente React, hook, painel visual ou tradução de i18n (ex.: `src/features/...`)*.

| Etapa | Regime Antigo | Regime Novo (`ags test affected`) | Ganho |
|---|---|---|---|
| **Babel Parse** | Não rodava isolado | 1s | Rápida detecção sintática |
| **Vitest** | Suíte completa: 14s | `vitest --changed`: 4s | 71% mais rápido |
| **TypeScript** | `tsc --noEmit`: 15s | Pulado ou 15s se tocar tipos | Reduz overhead quando desnecessário |
| **Cargo Test** | 204s (frio) ou 65s (morno) | **0s (Completamente pulado)** | 100% eliminado |
| **Tempo Total** | **~35s – 233s** | **~4s – 5s** | **85% a 98% de redução** |

### Caso 2: Mudança Exclusiva de Rust
*Cenário: Alteração em comando IPC, rotina, serialização ou regra de negócio (ex.: `src-tauri/src/...`)*.

| Etapa | Regime Antigo | Regime Novo (Target Compartilhado + Cache) | Ganho |
|---|---|---|---|
| **Compilação Inicial** | 204,63s (cold em novo worktree) | 14,55s (warm re-link com alvo compartilhado) | 93% mais rápido |
| **Execução Unchanged** | 204s ou rebuild parcial | 1,08s (no-op incremental) | 99,5% mais rápido |
| **Testes Frontend** | 29s (tsc 15s + vitest 14s) | **0s (Pulado por `test affected`)** | 100% eliminado |
| **Cache Hit (Árvore Limpa)**| Inexistente | 0ms (retorno imediato do SQLite) | Instantâneo |
| **Tempo Total** | **~233s (~4 minutos)** | **~14s (ou 1s com cache)** | **94% de redução** |

---

## 4. Regras Operacionais (Ponto 3 do Manifesto)

Para manter a velocidade e preservar os recursos de computação da máquina do desenvolvedor e das cotas dos agentes:

1. **Proibição de Suíte Completa Local Recorrente:**
   - Agentes **NÃO** devem executar a suíte completa de testes localmente a cada pequena modificação ou entrega intermediária.
   - O comando padrão para ciclo interno de validação é `ags test affected`.

2. **Aguardar CI ao Abrir PR:**
   - Ao abrir um Pull Request, a equipe confia na infraestrutura de integração contínua (GitHub Actions).
   - O acompanhamento deve ser feito via `gh pr checks <n> --watch` (bloqueio nativo do CLI do GitHub), sendo **estritamente proibido** fazer polling manual em loop com `sleep`/`Start-Sleep`.

3. **Exceções de Alto Risco para Suíte Completa Local:**
   A execução manual da suíte completa local é restrita exclusivamente a cenários de risco arquitetural crítico:
   - **Migrações de banco de dados** (mudanças de schema SQLite, scripts DDL e migrações aditivas);
   - **Código inseguro ou chamadas de baixo nível** (`unsafe`, chamadas COM do Windows, bindings C/Win32);
   - **Alterações de schema de mensagens/IPC** que afetem a ponte entre backend e múltiplos clientes.

---

## 5. Métrica de "Tempo de Espera do QA"

No modelo "QA em fluxo", a métrica `tempo de espera do QA` (`qaWaitMs`) passa a ser exposta em `ags mission timings <id>`.

- **Objetivo:** Quantificar o tempo em que o papel de QA permaneceu ocioso aguardando entregas dos integrantes ou aguardando respostas a perguntas bloqueantes.
- **Cálculo:** União dos períodos de ociosidade/bloqueio antes de validações e o tempo despendido em spans de espera (`peer_ask` ou `qa_wait`).
- **Meta:** Manter o QA alimentado continuamente através do protocolo onde o **Orquestrador notifica o QA a cada entrega recebida**, eliminando esperas acumuladas ao final da missão.
