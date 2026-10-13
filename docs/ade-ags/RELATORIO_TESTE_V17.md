# Relatório v17 — causa do teste Rust intermitente (mesma missão bbe782a6)

Detalhes e saídas exatas: `V17_BACKEND.md` e `V17_QA.md`. A janela do app não foi aberta.

## Causa

O teste `terminal::test::tests_e2e::matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente` falhava com "el nieto <pid> quedó huérfano tras matar el grupo" (2 falhas em 5 execuções da suíte completa nesta missão; neto 36812 na v14, 28540 na v16). **Era defeito do teste, não do produto**: reutilização de PID no Windows sob a concorrência da suíte.

Evidência capturada pela suíte instrumentada: o `PING.EXE` (PID 43408) estava no Job Object (`IsProcessInJob` = true) e `AssignProcessToJobObject` e `TerminateJobObject` retornaram sucesso; ~731 ms depois o Windows reciclou o PID 43408 para um `git.exe` de outros testes concorrentes. O helper `vivo(pid)` (via `tasklist`) casou o PID no `git.exe` e gerou o falso "neto órfão". A limpeza por `taskkill` de PID também podia atingir esse processo alheio.

## Conserto (commit `fe90c9d8`)

Só o teste: abre e mantém o handle do processo original antes do kill, espera até 5 s (`WaitForSingleObject`) e limpa pelo mesmo handle (`TerminateProcess`). Produto sem mudança de comportamento: em `containment.rs` os retornos de `AssignProcessToJobObject`/`TerminateJobObject` passaram a ser guardados e descartados fora de `#[cfg(test)]`; o diagnóstico (`[V17]` em `eprintln!` e `process_in_job`) existe só em teste.

## Medição (QA)

| Condição | Antes | Depois |
|---|---|---|
| Teste isolado, ocioso | 20/20 verdes | 20/20 verdes |
| Teste isolado, com carga | 10/10 verdes | — |
| `ags test run rust --force` completo | 1 falha numa das rodadas (R2, PID 43408 reaproveitado por `git.exe`) | 5/5 rodadas verdes (94,5 s, 45,5 s, 45,6 s, 44,8 s, 45,3 s) |

Órfãos: `Get-Process ping` = 0 em todas as etapas. Smoke 9/9; `ags test affected` verde. Backend: Rust 1377 + 45 verdes.

## Ressalvas

- O laço isolado nunca reproduziu a falha (só a suíte completa a expõe), então a prova é a causa capturada e não só a repetição: 5/5 depois é amostra pequena contra uma taxa de ~2/5 antes.
- Os casos históricos (36812 e 28540) não foram comprovados um a um como reutilização de PID; a captura é de uma ocorrência (43408).
- As linhas `[V17]` de diagnóstico seguem no código de teste e imprimem em toda execução; vale removê-las ou deixar sob uma variável de ambiente se atrapalharem.
- Vigia na v17: 0 linhas `[Vigia]` no terminal do QA; os avisos ao orquestrador sobre o Frontend ocioso (ocioso de propósito) se repetiram e foram ruído.
