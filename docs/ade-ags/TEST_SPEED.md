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
| **Cargo Test (Cold Build)** | `cargo test --lib --no-run` (target vazio) | **204,63s** (~3m 25s) | Compilação inicial fria de 519 crates dependentes do zero |
| **Cargo Test (Primeiro Aquecimento)** | `cargo test --lib --no-run` (após copiar target) | **64,7s** | Primeiro aquecimento após importação/cópia da base do target |
| **Cargo Test (Incremental CLI)** | `cargo test --lib --no-run` (pequena mudança no CLI) | **14,6s** (14,55s) | Re-linkagem/build incremental (`build.rs` acompanha src inteiro) |
| **Cargo Test (Warm Inalterado)** | `cargo test --lib` (alvo compartilhado aquecido, no-op) | **1,076s** | No-op incremental com alvo compartilhado sem modificações |
| **Cargo Lock Contention (4 simultâneos sob build CLI + mudança Git)** | 4 processos concorrentes sob build do CLI e alteração de refs | **Amostra 1:** 170,1s / 185,1s / 185,1s / 185,1s<br>**Amostra 2:** 121,1s / 134,9s / 135,0s / 135,0s<br>**Amostra 3:** 99,7s / 99,9s / 100,0s / 100,1s | Todos exit 0. O primeiro processo recompilou `ring`/`rustls`/`reqwest`/`ade-ags`, enquanto os demais aguardaram locks. O alvo sofre invalidação e concorrência reais (NÃO rotular como no-op puramente quente). |
| **Cargo Lock Contention (4 simultâneos - no-op inicial)** | 4 processos com alvo compartilhado sem alterações | **15,91s / 16,25s / 16,33s / 16,41s** *(provisório)* | Todos exit 0; disputa restrita ao lock de package cache/artifact directory. |

### Caveat do Backend: Invalidação do Target Compartilhado por Commits Concorrentes e Disputa Real de Lock
O target compartilhado reduz drasticamente o tempo de compilação eliminando a recompilação fria de 519 crates de dependências. Contudo, **o alvo compartilhado sofre invalidação e concorrência reais e NÃO deve ser rotulado como um simples no-op quente**:
- **Invalidação por Refs:** O script [`build.rs`](file:///C:/Users/tonz1n/.ags/worktrees/fe40e32d/src-tauri/build.rs) (`build_identity`) monitora `--git-path refs` (diretório compartilhado com todas as referências e branches no repositório comum).
- **Impacto em Equipe:** Novos commits criados por outros worktrees invalidam o cache da crate principal do app (`ade-ags`). Por isso, o estado "aquecido" não é garantidamente ~1s quando outros integrantes da equipe estão commitando ativamente em paralelo.
- **Disputa de Lock sob Compilação Concorrente:** Quando 4 processos foram disparados concorrentemente sob rebuild do CLI e mudanças no Git:
  - **Amostra 1:** 170,1s / 185,1s / 185,1s / 185,1s (todos exit 0)
  - **Amostra 2:** 121,1s / 134,9s / 135,0s / 135,0s (todos exit 0)
  - **Amostra 3:** 99,7s / 99,9s / 100,0s / 100,1s (todos exit 0)
  Nesses cenários, o primeiro processo que obtém o lock recompila crates afetadas (como `ring`, `rustls`, `reqwest` e `ade-ags`), enquanto os outros 3 processos serializam e aguardam a liberação do lock do diretório de artefatos.
- **Refinamento Futuro:** Ajustar o `build.rs` para rastrear apenas `HEAD` ou a ref específica da branch do worktree ativo, mantendo compatibilidade com `packed-refs`.
- **Documentação de Cache:** Para detalhes sobre o funcionamento da tabela `test_results`, validação de `HEAD^{tree}` e configuração de `ADE_AGS_CARGO_TARGET_DIR`, consulte [docs/ade-ags/TEST_CACHE.md](file:///C:/Users/tonz1n/.ags/worktrees/fe40e32d/docs/ade-ags/TEST_CACHE.md) ([TEST_CACHE.md](TEST_CACHE.md)).

### Nota sobre Sccache
Foi avaliada a utilização do `sccache` como camada adicional de cache de compilação:
- O binário `sccache` **não está instalado** no ambiente e **não é instalável sem privilégios de administrador** (bloqueio por ACL em `.cargo/.crates.toml`).
- O uso do diretório compartilhado `~/.ags/cargo-target-agents` (via variável `ADE_AGS_CARGO_TARGET_DIR`) atendeu plenamente à meta de redução de tempo, eliminando a penalidade fria de 204,63s e alcançando de 1,076s a 14,6s sem necessidade de binários extras.

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
- **Cache de Resultados (`test_results` em SQLite):** Resultados de árvores limpas (`HEAD^{tree}`) são persistidos. Re-execuções sem modificação retornam imediatamente com *cache hit* em 0ms (veja especificação técnica em [docs/ade-ags/TEST_CACHE.md](file:///C:/Users/tonz1n/.ags/worktrees/fe40e32d/docs/ade-ags/TEST_CACHE.md)).
- **QA em Fluxo:** O QA valida de forma contínua cada entrega assim que ela chega via `ags peer tell`. O orquestrador notifica o QA a cada entrega recebida.
- **Validação Final:** Apenas **UMA** execução completa ao final da integração (ou delegação ao CI via `gh pr checks <n> --watch`, sem scripts com *sleep polling*).

### Validação Final da Missão Integrada (Regime Novo em Produção)
Na etapa final de integração da missão, a suíte completa foi executada **uma única vez** no alvo compartilhado (`~/.ags/cargo-target-agents`):
- **Build inicial da suíte Rust completa:** **~3m32s** (compilação e linkagem integrada no alvo compartilhado).
- **Execução dos testes Rust integrados:** **25s** (**1.163 testes da lib + 31 testes de binários/CLI**, totalizando 1.194 testes Rust verdes, 0 falhas).
- **Vitest completo:** **11s** (**1.347 testes frontend verdes**, 0 falhas).
- **Total Integrado:** **2.541 testes automatizados (1.347 frontend + 1.194 Rust) 100% verdes**.

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

---

## 6. O que Roda em Cada SO no CI

O workflow [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) roda em todo PR e em todo push para `master`, com dois jobs independentes:

| SO | Job | O que roda | Tempo |
|---|---|---|---|
| **Linux** (`ubuntu-22.04`) | `test` | `tsc --noEmit`, `babel-parse-check`, `vitest` (`bun run test`), `cargo test --lib --bin ags` | **~4 min** |
| **Windows** (`windows-latest`) | `check (windows)` | `cargo check --lib --bins --tests` (compila o código `#[cfg(windows)]`, todos os binários e os testes, sem executá-los) | **3m44s** frio · **~1m40s** com cache quente (o passo do `cargo check` leva ~27s) |
| **macOS** | — | Nada no CI; só no release (`release.yml`) | — |

Referência local: `cargo check --lib --bin ags --tests` no Windows, com o alvo compartilhado (`~/.ags/cargo-target-agents`) já aquecido, levou **40,7s** (`Measure-Command`, exit 0). Esse número é anterior à troca para `--bins`. O job do Windows não precisa de bun nem da pasta `dist` do frontend: em build de debug o Tauri usa `devUrl`, e o check passou localmente sem `dist`.

Qualquer job que falhe já deixa o PR vermelho. Hoje a `master` **não tem branch protection nem rulesets** (`gh api repos/tonalenar/ADE-AGS/branches/master/protection` → 404 "Branch not protected"), então nenhum check é formalmente obrigatório para o merge.

### Por que `cargo check` e não `cargo test` no Windows
- **Medido:** `cargo test --lib --bin ags` no runner Windows (PR descartável 120, já fechado) **roda**: o binário sobe (o `build.rs` embute o manifesto de teste, então não há mais `STATUS_ENTRYPOINT_NOT_FOUND`). Resultado: **1266 passed, 2 failed, 10 ignored** em 71,6s; o passo levou **4m12s**.
- **As 2 falhas só aparecem no Windows:** `ipc::test::un_symlink_que_apunta_a_otro_lado_no_cuenta_como_instalado` (os error 183) e `missions::cleanup::tests::listing_and_prune_preserve_orphans_and_active_then_clean_closed`.
- **Decisão:** no CI do Windows fica só o `check`. Motivo: rodar os testes soma ~4 min ao job e as 2 falhas deixariam o job vermelho sem ser regressão de PR. Os testes com gate `#[cfg(windows)]` continuam sendo rodados à mão no Windows.
- O `cargo check` pega erros de compilação sem gerar código nem linkar.

### Prova: o job pega quebra só-Windows
- Branch descartável a partir do commit da doc de CI (`9380b6f`, reescrito depois como `8518e74`), com a linha `let _quebra: u32 = "texto-em-vez-de-numero";` dentro de `#[cfg(windows)]` em `src-tauri/src/ipc/transport.rs`.
- Local (Windows): `cargo check --lib --bin ags --tests` falhou com `error[E0308]: mismatched types` em `src-tauri/src/ipc/transport.rs:112`.
- CI: PR descartável [#118](https://github.com/tonalenar/ADE-AGS/pull/118) (fechado, branch apagada). Run [37695392738](https://github.com/tonalenar/ADE-AGS/actions/runs/37695392738): `check (windows)` **falhou** com `error[E0308]: mismatched types --> src\ipc\transport.rs:112:24`; `test` (Linux) ainda estava em execução (no passo de `cargo test`) quando o PR foi fechado, então não há resultado dele registrado aqui; a prova vale pelo `check (windows)`.

### Histórico
O PR **117** ("Windows: corrige o build do named pipe de credencial") corrigiu uma quebra só-Windows do named pipe de credencial que o CI de Linux não compilava; o run de CI desse PR levou ~18 min. O commit de correção (`a6e803e`) cita "(#113)" no assunto, mas o PR #113 mergeado é outro (M8, `50b21b1`), então a doc cita o 117. Não verificamos qual PR introduziu a quebra. O job `check (windows)` existe para pegar esse tipo de quebra antes do merge.
