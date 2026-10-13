# V17 Backend — causa do teste Rust intermitente

Missão bbe782a6-ec77-4100-8509-b6b1108b09ea. Branch cc/mission-bbe782a6-ec77-4100-8509-5d7ad611. Integração inicial autorizada: git merge cc/mission-bbe782a6-ec77-4100-8509-cb6b7b23, fast-forward 5712367c → c663d657 (estado com dev integrada). Sem branch nova, push ou PR.

## Resultado — CORRIGIDO (bug do teste)

A falha foi reproduzida na suíte completa instrumentada: PID **43408** era **PING.EXE** antes do kill e **git.exe** depois. O pai e o ping pertenciam ao Job Object; AssignProcessToJobObject e TerminateJobObject retornaram sucesso. O teste antigo consultava um PID reutilizável e confundiu outro processo com um neto sobrevivente. A limpeza antiga por taskkill /PID também podia atingir esse outro processo; não foi comprovado se o git observado chegou a ser morto pela limpeza.

Conserto limitado ao teste Windows: abrir e manter um OwnedHandle do ping original antes de matar o grupo; verificar término com WaitForSingleObject(handle,5000); na falha, limpar com TerminateProcess no MESMO handle. Prazo continua 5 s. Nenhuma alteração de política, adoção, spawn, kill ou fallback do produto. Diagnósticos extras só compilam em testes.

Depois do conserto: 5/5 repetições sob carga frontend passaram; affected verde; suíte Rust completa final forçada verde (1377 passaram, 10 ignorados, CLI 45/45).

## Diagnóstico antes de consertar

Arquivos e sequência conferidos:

- src-tauri/src/terminal/test.rs, módulo #[cfg(all(test, windows))] tests_e2e: PowerShell lança ping, publica NIETO=pid e dorme; teste adota o pai, mata job, espera até 5 s por consultas tasklist e faz outra consulta na asserção.
- src-tauri/src/terminal/containment.rs: criação do job, AssignProcessToJobObject, TerminateJobObject e CloseHandle. usa_job só confirmava handle de job não nulo, não a adoção bem-sucedida.
- src-tauri/src/terminal/pty_manager.rs:692-702: spawn_command antes de group.adopt.
- portable-pty 0.8.1 instalado, src/win/psuedocon.rs:136-142: CreateProcessW com EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, sem CREATE_SUSPENDED. Dependência foi só lida, não modificada.

| Hipótese | O código sustenta? | Evidência capturada | Conclusão |
|---|---|---|---|
| Neto nasce antes de adoção do pai | Possível, janela documentada em ProcessGroup::adopt | Na falha, pai e neto já estavam no job; nas 10 sondas também | Não explica a falha reproduzida |
| AssignProcessToJobObject falha e job parece válido | Possível: retorno era ignorado; usa_job não testa associação | Assign=true, parent_in_job=true e child_in_job=true na falha | Não ocorreu na falha reproduzida |
| Kill falha/é assíncrono e 5 s não bastam | Retorno do kill era ignorado e término pode exigir espera | Kill=true; PID mudou de ping para git; falha após 731 ms, antes de 5 s | Não é insuficiência do prazo nesse caso |
| Ping original fica vivo fora do job | Possível em janela pré-adoção, mas precisaria evidência | Ping estava dentro do job e desapareceu, liberando o PID | Não observado nesse caso |
| PID reutilizado entre duas consultas tasklist | Sim: vivo(pid) usa substrings do output e é chamado de novo depois do laço | PING.EXE43408 → git.exe43408; alive_after_kill=true aos 731 ms | **Causa confirmada** |

A herança de jobs se aplica aos filhos criados após associação; o retorno da adoção deve ser verificado para afirmar associação. Referência primária: [AssignProcessToJobObject — Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject). Essa janela teórica do produto permanece documentada e não foi confundida com a causa do teste.

O handle continua referindo-se ao mesmo processo após término; um identificador numérico não oferece a mesma identidade temporal. Referência: [Process Handles and Identifiers — Microsoft](https://learn.microsoft.com/en-us/windows/win32/procthread/process-handles-and-identifiers). O teste corrigido espera o objeto de processo sinalizado, mantendo o handle aberto durante a espera, com direito SYNCHRONIZE. Referência: [WaitForSingleObject — Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject).

**Linux/CI:** este teste específico NÃO roda no Linux, pois é cfg(windows). CI Linux verde não demonstra que esse teste Windows passou. O módulo Linux e sua implementação de cgroups foram preservados sem mudança no diff final; não foi alegada execução Linux local.

## Reprodução e estado exato na falha

Histórico recebido: 2/5 falhas (PIDs 36812 na v14, 28540 na v16). Os estados desses processos não estavam registrados; não se afirma que todas as falhas antigas tiveram causa idêntica. O caso v17 abaixo comprova a reutilização de PID e explica a mesma mensagem de erro.

As 25 primeiras repetições isoladas passaram. A falha apareceu ao executar todos os testes Rust concorrentes, cenário com vários processos git de testes SCM/testspeed. Comando via CLI (fase de reprodução instrumentada, antes do conserto):

```powershell
ags test run rust --force
```

Saída exata pertinente:

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
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace


failures:
test result: FAILED. 1376 passed; 1 failed; 10 ignored; 0 measured; 0 filtered out; finished in 44.28s
{"cacheHit":false,"durationMs":118226,"message":"resultado registrado","passed":false,"suite":"rust","treeHash":"261e924a61561e94f618076a2bc73da04d6efe2f"}
EXIT_RUST_FINAL=1
```

Como a falha ocorreu aos 731 ms, o laço não esgotou seus 5 s: a primeira checagem já não viu ping, saiu do laço, e a segunda checagem encontrou git com o mesmo PID. Esse TOCTOU está removido no teste corrigido. Nenhum aumento de timeout ou sleep arbitrário foi aplicado.

## Amostras em laço — 30 execuções

Target Cargo usado: C:\Users\tonz1n\.ags\cargo-target-agents, separado do app instalado. Nunca foi usado cargo build --bin ags. A exceção de cargo test cru foi limitada ao único teste indicado.

Primeiro comando, repetido cinco vezes:

```powershell
$env:CARGO_TARGET_DIR='C:\Users\tonz1n\.ags\cargo-target-agents'
cargo test --lib matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente -- --nocapture
```

A compilação disputou lock com outras builds: soma wall 386,969 s para testes que somam 11 s. Saída exata do segundo cargo:

```text
Blocking waiting for file lock on artifact directory
Compiling ade-ags v1.8.7 (C:\Users\tonz1n\.ags\worktrees\5d7ad611\src-tauri)
Finished `test` profile [unoptimized + debuginfo] target(s) in 2m 04s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1386 filtered out; finished in 1.99s
```

Para não medir recompilação/lock em cada repetição, os binários de teste já construídos foram copiados para TEMP (fora do repo) e fixados por fase; só a mesma função foi executada, com --exact:

```powershell
& "$env:TEMP\v17_baseline_probe.exe" --exact terminal::test::tests_e2e::matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente --nocapture
& "$env:TEMP\v17_instrumented_probe.exe" --exact terminal::test::tests_e2e::matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente --nocapture
& "$env:TEMP\v17_fixed_probe.exe" --exact terminal::test::tests_e2e::matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente --nocapture
```

Identidade dos dois primeiros binários:

- baseline SHA-256: 317b2c1a83ce250fc2e416497c42860c1e1068a48ac1b3def8e938271635480c
- instrumentado SHA-256: 2ed4db91d98a4f85ca46fdd63681ac42a369081539c079ef5c54eb3369862a05

Cargas frontend controladas: subprocesso ags test run frontend --force, em janela oculta, stdout capturado em TEMP. As cinco repetições de cada fase load_frontend e fixed_load_frontend terminaram enquanto esse subprocesso ainda estava rodando; cargas terminaram exit 0. A fase load_existing_cargo observou cargo/rustc ativos no início, mas a carga não foi controlada nem monitorada durante cada repetição — não tratar como benchmark rigoroso sob carga sustentada.

| Fase | N | Falhas | Média teste (s) | Mediana (s) | Faixa (s) | Wall total (s) |
|---|---:|---:|---:|---:|---|---:|
| baseline cargo | 5 | 0 | 2,200 | 2,090 | 1,81–2,67 | 386,969 |
| binário, cargo/rustc concorrentes no início | 5 | 0 | 2,032 | 2,040 | 2,00–2,06 | 10,750 |
| binário, carga frontend controlada | 5 | 0 | 2,104 | 2,120 | 1,93–2,39 | 10,625 |
| instrumentado | 10 | 0 | 1,993 | 1,945 | 1,93–2,29 | 20,594 |
| corrigido, carga frontend controlada | 5 | 0 | 2,898 | 3,000 | 2,08–3,28 | 15,234 |

**Taxas:** laço antes do conserto 0/25; laço depois 0/5. A fase instrumentada de suíte completa teve 1 falha; não misturar seu contexto com a amostra de função isolada. Carga frontend não fez a falha antiga aparecer em cinco casos; carga de suíte Rust completa reproduziu o caso com git/PID reutilizado. Amostra pequena, sem estimar probabilidade universal nem afirmar que o produto nunca pode perder contenção.

Execuções individuais, cada qual com saída test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1386 filtered out; finished in <tempo teste>s:

| Fase | Execução | Exit | Tempo teste (s) | Wall (s) |
|---|---:|---:|---:|---:|
| baseline | 1 | 0 | 2.67 | 21.578 |
| baseline | 2 | 0 | 1.99 | 126.594 |
| baseline | 3 | 0 | 2.44 | 105.172 |
| baseline | 4 | 0 | 2.09 | 105.515 |
| baseline | 5 | 0 | 1.81 | 28.110 |
| load_existing_cargo | 1 | 0 | 2.04 | 2.547 |
| load_existing_cargo | 2 | 0 | 2.00 | 2.016 |
| load_existing_cargo | 3 | 0 | 2.02 | 2.047 |
| load_existing_cargo | 4 | 0 | 2.06 | 2.078 |
| load_existing_cargo | 5 | 0 | 2.04 | 2.062 |
| load_frontend | 1 | 0 | 1.96 | 1.984 |
| load_frontend | 2 | 0 | 1.93 | 1.953 |
| load_frontend | 3 | 0 | 2.12 | 2.125 |
| load_frontend | 4 | 0 | 2.39 | 2.422 |
| load_frontend | 5 | 0 | 2.12 | 2.141 |
| instrumented | 1 | 0 | 1.93 | 2.438 |
| instrumented | 2 | 0 | 1.95 | 1.968 |
| instrumented | 3 | 0 | 1.98 | 2.000 |
| instrumented | 4 | 0 | 1.97 | 1.985 |
| instrumented | 5 | 0 | 1.94 | 1.953 |
| instrumented | 6 | 0 | 1.94 | 1.953 |
| instrumented | 7 | 0 | 1.94 | 1.953 |
| instrumented | 8 | 0 | 2.06 | 2.094 |
| instrumented | 9 | 0 | 1.93 | 1.953 |
| instrumented | 10 | 0 | 2.29 | 2.297 |
| fixed_load_frontend | 1 | 0 | 2.08 | 2.640 |
| fixed_load_frontend | 2 | 0 | 2.90 | 2.938 |
| fixed_load_frontend | 3 | 0 | 3.23 | 3.297 |
| fixed_load_frontend | 4 | 0 | 3.00 | 3.031 |
| fixed_load_frontend | 5 | 0 | 3.28 | 3.328 |

Os JSONs integrais com comando/stdout/stderr/horário por repetição estão em TEMP/v17_baseline.json, v17_load_existing_cargo.json, v17_load_frontend.json, v17_instrumented.json e v17_fixed_load_frontend.json. Este relatório preserva contagens e trechos necessários mesmo se TEMP for limpo. Nenhum binário/log volumoso foi adicionado ao repositório.

## Instrumentação e conserto

Arquivos alterados:

- src-tauri/src/terminal/containment.rs: logs cfg(test) dos retornos Assign/Terminate e helper cfg(test) que consulta IsProcessInJob, abre/fecha seu handle imediatamente. Nenhuma mudança de comportamento em builds normais.
- src-tauri/src/terminal/test.rs: logs do pai/neto, timings, snapshot tasklist como diagnóstico; conserto da identidade com OwnedHandle/WaitForSingleObject e cleanup no mesmo handle. Mudanças limitadas ao módulo Windows.
- docs/ade-ags/V17_BACKEND.md: diagnóstico, comandos, estado da falha e validação.

Na revisão da primeira instrumentação, um padrão textual também havia atingido o bloco Linux homônimo; foi restaurado antes do conserto e da entrega. O diff final só contém a instrumentação e o ajuste Windows. As duas validações de instrumentação foram verdes no Windows; a primeira tinha aviso de helper não usado, resolvido ao restringir os pontos ao módulo correto. O conserto causal do teste teve uma rodada; não houve tentativa especulativa de mudar produto.

Antes do conserto, dez diagnósticos: pai no job=10/10, neto no job=10/10, Assign=true=10/10, Terminate=true=10/10. Adoção medida em 95–162 µs após retorno do spawn; observação de neto ausente pós-kill em 448–504 ms, incluindo custo de duas chamadas tasklist. Isso mede a observação, não o instante exato da morte.

Exemplo exato posterior ao conserto:

```text
[V17] AssignProcessToJobObject ok=true error=none
[V17] root=Some(25932) spawn_us=14399 adopt_us=181 root_in_job=Some(Ok(true))
[V17] tasklist pid=47028 text="\r\nPING.EXE                     47028 Console                    1      5.596 K\r\n"
[V17] nieto=47028 in_job_before_kill=Ok(true)
[V17] TerminateJobObject ok=true error=none
[V17] nieto=47028 original_wait=0 elapsed_ms=9
running 1 test
test terminal::test::tests_e2e::matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1386 filtered out; finished in 2.08s
```

Todos os cinco corrigidos tiveram original_wait=0 (WAIT_OBJECT_0), observado em 8–19 ms após kill/fechamento de PTY. Não se afirma melhoria de performance a partir dessa comparação: mudaram o observador e a carga.

## Validação final — CORRIGIDO/FUNCIONA

ags test affected selecionou Rust completo porque a instrumentação e o teste contêm unsafe Windows. Sem alterações de schema, versões, instalador, CI, segurança/permissões configuradas, Contas, chaves, Decisões ou banco real. O app não foi aberto, fechado ou reiniciado. Helpers externos apenas leem processo/arquivo de teste; cleanup pertence ao próprio ping de fixture.

Após conserto, comando ags test affected — exit 0:

```text
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1386 filtered out; finished in 0.04s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1386 filtered out; finished in 0.07s
test terminal::test::tests_e2e::matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente ... ok
test result: ok. 1377 passed; 0 failed; 10 ignored; 0 measured; 0 filtered out; finished in 42.33s
test result: ok. 45 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
{"full":true,"ignored":["docs/ade-ags/RELATORIO_TESTE_V14.md","docs/ade-ags/RELATORIO_TESTE_V15.md","docs/ade-ags/RELATORIO_TESTE_V16.md","docs/ade-ags/V14_BACKEND.md","docs/ade-ags/V14_FRONTEND.md","docs/ade-ags/V14_QA.md","docs/ade-ags/V15_BACKEND.md","docs/ade-ags/V15_FRONTEND.md","docs/ade-ags/V15_QA.md","docs/ade-ags/V16_BACKEND.md","docs/ade-ags/V16_FRONTEND.md","docs/ade-ags/V16_QA.md"],"passed":true,"results":[{"cacheHit":true,"durationMs":0,"message":"já verde neste hash (há 36 min)","passed":true,"suite":"babel","treeHash":"6ef9de84e78e6744069438696402a5ef07e58945"},{"cacheHit":true,"durationMs":0,"message":"já verde neste hash (há 36 min)","passed":true,"suite":"tsc","treeHash":"6ef9de84e78e6744069438696402a5ef07e58945"},{"cacheHit":true,"durationMs":0,"message":"já verde neste hash (há 36 min)","passed":true,"suite":"frontend","treeHash":"6ef9de84e78e6744069438696402a5ef07e58945"},{"cacheHit":false,"durationMs":62928,"message":"resultado registrado","passed":true,"suite":"rust","treeHash":"6ef9de84e78e6744069438696402a5ef07e58945"}],"risk":["src-tauri/src/terminal/containment.rs (unsafe/COM do Windows)","src-tauri/src/terminal/test.rs (adiciona unsafe)"],"skippedAffected":0,"unmapped":[]}
```

Comando final obrigatório ags test run rust --force — exit 0 (execução real, sem cache):

```text
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1386 filtered out; finished in 0.06s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1386 filtered out; finished in 0.10s
test terminal::test::tests_e2e::matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente ... ok
test result: ok. 1377 passed; 0 failed; 10 ignored; 0 measured; 0 filtered out; finished in 43.39s
test result: ok. 45 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
{"cacheHit":false,"durationMs":44719,"message":"resultado registrado","passed":true,"suite":"rust","treeHash":"6ef9de84e78e6744069438696402a5ef07e58945"}
EXIT_RUST_FIXED_FINAL=0
```

A chamada completa anterior, que falhou, virou a reprodução causal acima; depois do conserto foi feita a validação completa final na árvore estável. Não se reutilizou um verde pré-conserto. git diff --check passou sem saída. Branch única mantida; Orquestrador integra e gerencia o PR único.
