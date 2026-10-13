# Relatório de QA / Testes — Rodada V17 (Medição e Verificação do Teste Rust Intermitente)

- **Data / Horário**: 2026-10-13 07:46 (UTC-3)
- **Worktree**: `C:\Users\tonz1n\.ags\worktrees\884e97d2`
- **Branch**: `cc/mission-bbe782a6-ec77-4100-8509-884e97d2` (HEAD: `fe90c9d8`, merge fast-forward da entrega do Backend)
- **Agente**: Antigravity (`QA / Tests`, tab id: `02ec1ed2-da25-4693-9771-b31826694e34`)
- **Missão ID**: `bbe782a6-ec77-4100-8509-b6b1108b09ea`

---

## 1. Resumo Executivo da Rodada V17

| Item de Avaliação | Status | Síntese do Achado |
|---|---|---|
| **Causa Raiz do Teste Intermitente** | **COMPROVADA (Bug do Teste, Não do Produto)** | O teste `matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente` falhava intermitentemente (~2/5) não por escape de processo ou falha do Job Object, mas por **reutilização de PID no Windows** sob concorrência na suíte de testes. |
| **Comportamento de Contenção do Produto** | **FUNCIONA (100% Íntegro)** | `AssignProcessToJobObject` associa o processo pai com sucesso; o neto (`PING.EXE`) nasce dentro do Job Object (`in_job_before_kill = Ok(true)`); `TerminateJobObject` encerra o processo imediatamente sem deixar processos órfãos. |
| **Mecanismo da Falsa Falha** | **REPRODUZIDO E DOCUMENTADO** | Na suíte completa, o `PING.EXE` (PID 43408) foi morto em <700 ms. O Windows imediatamente reciclou o PID 43408 para um novo processo `git.exe` disparado concorrentemente por outros testes (`testspeed`/`scm`). O helper `vivo(pid)` usava `tasklist` com busca textual por substring do PID, detectou o `git.exe 43408` e disparou pânico alegando falso neto órfão. |
| **Correção Aplicada pelo Backend (`fe90c9d8`)** | **APROVADA E VALIDADA** | Mudança cirúrgica restrita ao teste: abre `OwnedHandle` com `OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE)` e aguarda término via `WaitForSingleObject(handle, 5000)`. Garante identidade estável do objeto no kernel (o handle impede reciclagem temporal do objeto) e limpeza exclusiva pelo handle. Nenhum código de produção foi alterado. |
| **Medição Isolada (Antes vs Depois)** | **FUNCIONA (0% falhas)** | Antes: 20/20 idle passaram (média 4,79 s) e 10/10 sob carga passaram (média 5,42 s). Depois: 20/20 pós-conserto passaram (média 3,57 s). |
| **Medição Suíte Completa Rust (`ags test run rust --force`)** | **FUNCIONA (5/5 Rodadas Passaram — 0% Falhas)** | 5 rodadas consecutivas da suíte completa Rust (1.377 testes lib + 45 testes CLI) passaram com 0 falhas (100% verdes). Flake eliminado. |
| **Auditoria de Processos Órfãos** | **LIMPO** | Em nenhuma execução restaram processos `ping.exe` ou `powershell.exe` órfãos no sistema operacional (`Get-Process ping` = 0). |
| **Regressão `ags test smoke`** | **FUNCIONA** | 9/9 testes passaram (0 falhas). |
| **Regressão `ags test affected`** | **FUNCIONA** | 100% verde em todas as suítes (babel, tsc, frontend, rust). |
| **Vigia ligado (Terminal QA)** | **FUNCIONA** | Zero linhas `[Vigia]` no terminal QA. Zero ocorrências de `[Pasted text #N]` empacado. Zero falso alarme. |

---

## 2. Diagnóstico Cabal da Causa Raiz e Mecanismo de Falha

### 2.1 A Evidência Crucial Capturada

Durante a execução da suíte completa de testes Rust (`ags test run rust --force`) com diagnósticos `#[cfg(test)]` ativos, a falha histórica foi reproduzida exatamente:

```text
---- terminal::test::tests_e2e::matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente stdout ----
[V17] AssignProcessToJobObject ok=true error=none
[V17] root=Some(45688) spawn_us=19389 adopt_us=30 root_in_job=Some(Ok(true))
[V17] tasklist pid=43408 text="\r\nPING.EXE                     43408 Console                    1      5.568 K\r\n"
[V17] nieto=43408 in_job_before_kill=Ok(true)
[V17] TerminateJobObject ok=true error=none
[V17] tasklist pid=43408 text="\r\ngit.exe                      43408 Console                    1      7.896 K\r\n"
[V17] nieto=43408 alive_after_kill=true elapsed_ms=731

thread 'terminal::test::tests_e2e::matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente' (24100) panicked at 
src\terminal\test.rs:496:9:
el nieto 43408 quedó huérfano tras matar el grupo
```

### 2.2 Desconstrução Passo a Passo

1. **Adoção e Contenção Impecáveis**:
   - `AssignProcessToJobObject` retornou `ok=true` 30 µs após o spawn do processo pai (`PowerShell`, PID 45688).
   - O processo filho `PING.EXE` (PID 43408) foi comprovadamente herdado pelo Job Object: `in_job_before_kill=Ok(true)`.
2. **Término Imediato**:
   - `TerminateJobObject` retornou `ok=true`. O kernel do Windows encerrou `PING.EXE` imediatamente.
3. **Reciclagem Agressiva de PID no Windows**:
   - Como a suíte completa Rust executa 1.377 testes em paralelo em múltiplas threads (incluindo testes de SCM e `testspeed` que invocam comandos `git` dezenas de vezes por segundo), o kernel do Windows liberou o PID 43408 e imediatamente o reatribuiu a um novo processo `git.exe`.
4. **Falso Positivo do Helper `vivo(pid)`**:
   - O código anterior do teste verificava a sobrevivência com:
     ```rust
     fn vivo(pid: u32) -> bool {
         std::process::Command::new("tasklist")
             .args(["/FI", &format!("PID eq {pid}"), "/NH"])
             .output()
             .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
             .unwrap_or(false)
     }
     ```
   - O teste chamou `tasklist /FI "PID eq 43408" /NH`.
   - A saída do `tasklist` foi: `git.exe 43408 Console 1 7.896 K`.
   - Como a string continha `"43408"`, o teste deduziu que o `ping` ainda estava vivo após 731 ms (muito antes do timeout de 5 segundos) e executou `taskkill /F /PID 43408`, tentando matar o `git.exe` alheio!
   - Em seguida, disparou o pânico `el nieto 43408 quedó huérfano tras matar el grupo`.

### 2.3 Por que o teste nunca falhava isoladamente?
Em execuções isoladas (em laço de 20 repetições), nenhum outro teste concorrente estava gerando novos processos a alta frequência no sistema. Portanto, uma vez que o PID era liberado pelo término do `ping`, ele não era reutilizado nos 500 ms seguintes, fazendo o teste passar 100% das vezes.

---

## 3. A Correção do Backend (`fe90c9d8`)

A correção em `src-tauri/src/terminal/test.rs` eliminou o acoplamento frágil com PIDs numéricos voláteis:

```rust
fn process_handle(pid: u32) -> OwnedHandle {
    // O handle fica válido após a morte do processo; o PID pode ser reutilizado.
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid) };
    assert!(!handle.is_null(), "OpenProcess({pid}): {}", std::io::Error::last_os_error());
    // SAFETY: OpenProcess devolveu um handle válido, transferido uma única vez ao RAII.
    unsafe { OwnedHandle::from_raw_handle(handle as _) }
}
```

E no corpo do teste:
```rust
let original = process_handle(nieto);
let handle = original.as_raw_handle() as HANDLE;
assert_eq!(unsafe { WaitForSingleObject(handle, 0) }, WAIT_TIMEOUT, "el nieto tendría que estar vivo antes de matar el grupo");
...
group.kill_all();
drop(pty);

// Espera o processo ORIGINAL, sem consultar de novo um PID que pode ser de git/tasklist.
let wait = unsafe { WaitForSingleObject(handle, 5_000) };
if wait != WAIT_OBJECT_0 {
    // A limpeza também usa identidade estável: nunca mata outro processo pelo PID reciclado.
    unsafe { TerminateProcess(handle, 1); }
}
assert_eq!(wait, WAIT_OBJECT_0, "el nieto original {nieto} quedó vivo tras matar el grupo (wait={wait})");
```

**Benefícios da solução**:
1. Manter um handle aberto (`OpenProcess`) garante que a estrutura interna do objeto de processo do kernel (`EPROCESS`) seja preservada até o fechamento do handle.
2. `WaitForSingleObject` aguarda a sinalização direta do objeto de kernel do processo original, imune a reaproveitamento de PID por processos terceiros.
3. Se houvesse sobrevivência real, `TerminateProcess(handle, 1)` atuaria unicamente sobre o processo monitorado, sem risco de matar processos de outros testes.

---

## 4. Tabela de Medição Comparativa (Antes vs Depois)

### 4.1 Teste Isolado em Laço Curto (`matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente`)

| Condição | Estado do Sistema | N Execuções | Passou | Falhou | Taxa de Falha | Tempo Médio |
|---|---|---:|---:|---:|---:|---:|
| **Antes (Baseline Idle)** | Ocioso (sem concorrência de compilação) | 20 | 20 | 0 | **0,0%** | 4,79 s |
| **Antes (Sob Carga)** | Concorrência de compilação Cargo / rustc | 10 | 10 | 0 | **0,0%** | 5,42 s |
| **Depois (Pós-Fix `fe90c9d8`)** | Pós-correção com `OwnedHandle` e `WaitForSingleObject` | 20 | 20 | 0 | **0,0%** | **3,57 s** |

*Nota de Desempenho*: A duração média por iteração caiu de 4,79 s para 3,57 s (ganho de ~25%) devido à eliminação do overhead de spawn de processos `tasklist.exe` em laço de polling.

### 4.2 Suíte Completa Rust (`ags test run rust --force`)

| Rodada | Fase | Duração (s) | Testes Lib (1.377) | Testes CLI (45) | Resultado | Observações |
|---|---|---:|---|---|---|---|
| **R1 (Antes)** | Baseline | 108,56 s | 1.377 ok (0 falhas) | 45 ok | **PASSOU** | Execução limpa |
| **R2 (Antes)** | Sob Carga / Diagnóstico | 118,22 s | 1.376 ok (1 falha) | — | **FALHOU** | Falha reproduzida: PID 43408 reutilizado por `git.exe` aos 731 ms |
| **R1 (Depois)** | Pós-Fix `fe90c9d8` | 94,47 s | 1.377 ok (0 falhas) | 45 ok | **PASSOU** | Suíte completa verde após compilação |
| **R2 (Depois)** | Pós-Fix `fe90c9d8` | 45,47 s | 1.377 ok (0 falhas) | 45 ok | **PASSOU** | Suíte completa verde |
| **R3 (Depois)** | Pós-Fix `fe90c9d8` | 45,57 s | 1.377 ok (0 falhas) | 45 ok | **PASSOU** | Suíte completa verde |
| **R4 (Depois)** | Pós-Fix `fe90c9d8` | 44,78 s | 1.377 ok (0 falhas) | 45 ok | **PASSOU** | Suíte completa verde |
| **R5 (Depois)** | Pós-Fix `fe90c9d8` | 45,25 s | 1.377 ok (0 falhas) | 45 ok | **PASSOU** | Suíte completa verde |

**Consolidação Pós-Fix**: **5 de 5 rodadas consecutivas da suíte completa Rust passaram sem nenhuma falha intermitente (0% de falha, 100% de estabilidade).**

---

## 5. Auditoria de Processos Órfãos no Sistema Operacional

Conforme as regras estritas da rodada V17, foi realizado monitoramento contínuo de processos remanescentes antes, durante e após as medições:

```powershell
Get-Process ping -ErrorAction SilentlyContinue
```

- **Após 20 repetições isoladas pré-fix**: 0 processos `ping.exe` órfãos.
- **Após 10 repetições sob carga pré-fix**: 0 processos `ping.exe` órfãos.
- **Após falha na suíte completa R2 pré-fix**: 0 processos `ping.exe` órfãos (o `ping` real foi devidamente terminado pelo Job Object).
- **Após 20 repetições pós-fix**: 0 processos `ping.exe` órfãos.
- **Após 5 rodadas completas da suíte Rust pós-fix**: 0 processos `ping.exe` órfãos.

Nenhum processo alheio foi finalizado manualmente pelo QA em nenhuma fase do teste.

---

## 6. Verificação de Regressão e Smoke Test

### 6.1 `ags test smoke` (9/9)

```text
ok    app responde (tab list) — 6 abas (0 ms)
ok    tab output da própria aba — leu as últimas linhas (428 ms)
ok    tab inexistente é recusada — Esta janela não tem nenhuma aba com o id smoke-inexistente (3 ms)
ok    missão inexistente é recusada — não há nenhuma missão smoke-inexistente (0 ms)
ok    peers — lista a equipe (1 ms)
ok    memória: índice — índice lido (41 ms)
ok    --file chega como text (CLI) — 92 caracteres, aspas/acento/$HOME/crase intactos (1 ms)
ok    --file inexistente dá erro de leitura — erro de leitura claro, nada enviado (0 ms)
ok    peer tell a destino inexistente é recusado — recusado sem entregar nada: 'smoke-inexistente' não está conectado com você. C (1 ms)
{"checks":[...],"failed":0,"passed":true}
```
**Resultado**: **PASSOU (9/9 ok, 0 falhas).**

### 6.2 `ags test affected`

```json
{
  "full": true,
  "ignored": [
    "docs/ade-ags/RELATORIO_TESTE_V14.md",
    "docs/ade-ags/RELATORIO_TESTE_V15.md",
    "docs/ade-ags/RELATORIO_TESTE_V16.md",
    "docs/ade-ags/V14_BACKEND.md",
    "docs/ade-ags/V14_FRONTEND.md",
    "docs/ade-ags/V14_QA.md",
    "docs/ade-ags/V15_BACKEND.md",
    "docs/ade-ags/V15_FRONTEND.md",
    "docs/ade-ags/V15_QA.md",
    "docs/ade-ags/V16_BACKEND.md",
    "docs/ade-ags/V16_FRONTEND.md",
    "docs/ade-ags/V16_QA.md",
    "docs/ade-ags/V17_BACKEND.md"
  ],
  "passed": true,
  "results": [
    { "cacheHit": true, "durationMs": 0, "message": "já verde neste hash (há 55 min)", "passed": true, "suite": "babel" },
    { "cacheHit": true, "durationMs": 0, "message": "já verde neste hash (há 54 min)", "passed": true, "suite": "tsc" },
    { "cacheHit": true, "durationMs": 0, "message": "já verde neste hash (há 54 min)", "passed": true, "suite": "frontend" },
    { "cacheHit": true, "durationMs": 0, "message": "já verde neste hash (há 0 min)", "passed": true, "suite": "rust" }
  ],
  "risk": [
    "src-tauri/src/terminal/containment.rs (unsafe/COM do Windows)",
    "src-tauri/src/terminal/test.rs (adiciona unsafe)"
  ],
  "skippedAffected": 0,
  "unmapped": []
}
```
**Resultado**: **PASSOU (100% verde em todas as suítes).**

---

## 7. Observação do Vigia no Terminal QA

Durante toda a rodada V17 (com o botão do olho / Vigia ligado no app):
- **Linhas `[Vigia]` recebidas no terminal QA**: **Zero (0)**.
- **`[Pasted text #N]` empacado**: **Zero (0)**.
- **Falsos alarmes de inatividade**: **Zero (0)**.
- **Cutucadas indevidas pós-entrega**: **Zero (0)**.

---

## 8. Conclusão da Validação de QA

A intermitência no teste `matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente` foi definitivamente diagnosticada, reproduzida com evidência cabal de reutilização de PID (`PING.EXE` → `git.exe` no mesmo PID 43408), corrigida de forma cirúrgica e elegante pelo Backend sem tocar em nenhum código de produto, e comprovada estável em 5 rodadas consecutivas da suíte completa Rust (5/5 verdes, 0% falhas).

**Entrega de QA / Testes V17 pronta e validada.**
