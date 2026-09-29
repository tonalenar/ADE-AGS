# Baseline Windows

Resultado de provar o ControlCode 1.8.7, commit de upstream `632a57b`, neste clone. Os dois ajustes de código desta etapa estão descritos em [Correções](#correções). Não houve rebrand, nem mudança de provider, nem multi-conta do Gemini.

A branch é `feat/ade-ags-bootstrap`. `master` local não recebeu commit.

## Ambiente

Máquina Windows. Conta GitHub do `gh`: `tonalenar`.

| Ferramenta | Versão | Status |
|---|---|---|
| git | 2.55.0.windows.5 | presente |
| GitHub CLI | 2.93.0 | autenticado (`gist`, `read:org`, `repo`, `workflow`) |
| Node.js | 24.14.0 | presente |
| npm | 11.9.0 | presente |
| bun | 1.3.14 | presente. É o gerenciador que o projeto documenta |
| rustc | 1.95.0 (host `x86_64-pc-windows-msvc`) | presente |
| cargo | 1.95.0 | presente |
| rustup | 1.29.0 | presente. Só o target MSVC |
| Visual Studio Build Tools 2022 | 17.14.37301.10 | toolset presente. O instalador marca a instância como incompleta e não lançável |
| MSVC | 14.44.35207 | `cl` / `link` não estão no `PATH`. O `rustc` acha pelo `vswhere` |
| Windows SDK | 10.0.26100.0 | presente (`rc.exe` usado pelo manifesto de teste) |
| WebView2 Runtime | 154.0.4258.37 | presente |
| NSIS (`makensis`) | — | ausente |
| WiX (`candle`, `light`) | — | ausente |
| cmake, nasm, clang | — | ausentes. O caminho documentado (`bun` + `cargo`) não pede |

`core.autocrlf` global e de sistema estão `true`. Neste clone, `core.autocrlf` local está `false`. O `.gitattributes` (`* text=auto eol=lf`) é o que torna o checkout reproduzível em outra máquina. Não se alterou a configuração global do git.

Credential helper do git de sistema: `manager` (Git Credential Manager), nos dois `gitconfig` de instalação.

## Comandos

Dependências: `bun install` (297 pacotes). O lockfile do bun não ficou sujo.

| Comando | Resultado |
|---|---|
| `bunx tsc --noEmit` | saiu 0, antes do build |
| `bun run test` | 57 arquivos, 486 testes, todos passaram (4,2 s) |
| `bun run build` | correu dentro do `app:build`: `tsc && vite build`, 821 módulos, 16 s. Aviso do Vite de chunk acima de 500 kB. É do upstream |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 480 passaram, 33 falharam, 3 ignorados, 15,3 s. O harness sobe |
| `cargo test --lib forge::test::git_manda_el_token` | passou em 0,11 s, depois da correção do config |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- --no-deps` | saiu 0. 30 avisos na lib, 40 no alvo de teste (30 repetidos). Nenhum nos arquivos desta etapa |
| `cargo clippy ... -- -D warnings` | sai 1. Os avisos do upstream viram erro. Não é o comando do README. Não se rodou `cargo clippy --fix` |
| `bun run app:build` | saiu 0 em 4 min 42 s. Executável em `src-tauri/target/release/controlcode.exe` (29 853 696 bytes). A CLI foi omitida (`CC_CLI_SKIP=1`), que é o comportamento do script |
| `bun run app:build --release` | não rodou. Pede NSIS e WiX, que não estão instalados. Não se instalou |

Três testes Rust estão `#[ignore]` de fábrica: o keyring real (`forge::test::el_llavero_del_sistema_guarda_y_devuelve_el_token`) e dois do marketplace que precisam de rede.

## O executável

`controlcode.exe` foi iniciado, ficou vivo 5 segundos, com janela de título `controlcode`, e foi encerrado. Não se percorreu a UI. Não há suíte de browser para esta app Tauri.

## Problemas

### O harness de `cargo test` não carregava

A primeira compilação dos testes terminou e o executável de teste morreu com `0xc0000139` (`STATUS_ENTRYPOINT_NOT_FOUND`) antes de qualquer teste. O `dumpbin` mostrou import de `TaskDialogIndirect` em `comctl32.dll` e nenhum manifesto. Sem Common Controls 6 o loader liga o `comctl32` v5, que não exporta essa função. O `tauri-build` embute o manifesto só nos binários da app. O upstream já descreve isso em `examples/orphan_probe.rs`.

`cargo:rustc-link-arg-tests` não chega ao `cargo test --lib`: o Cargo só entrega esse argumento a `tests/*.rs`. Conferido com `cargo test --lib --no-run -v`.

### CRLF quebrava dois testes de frontend

Os blobs do git são LF. Com `core.autocrlf=true` o worktree veio em CRLF e o `git status` continuava limpo (cache de stat). `git reset --hard` não reescreveu.

- `catalog.test.ts` exige `\n` depois do `id` do registry Rust. Com CRLF a lista vinha vazia.
- `scripts/updater-manifest.mjs` começa com `#!/usr/bin/env bun`. O loader SSR do Vite envolve o módulo numa função. O shebang com CRLF não é removido e o V8 recusa o `#`.

Apagar os arquivos rastreados e fazer `git checkout -- .` com `core.autocrlf` local `false` reescreveu o worktree em LF. A suíte passou. O `.gitattributes` evita a recaída.

### Falhas que são desta máquina, não desta etapa

Com o código desta branch, `cargo test --manifest-path src-tauri/Cargo.toml --lib`: **480 passaram, 33 falharam, 3 ignorados**, 15,3 s. O teste do forge passa dentro dessa suíte.

Antes da correção do gitconfig, a mesma suíte ficou 403 s presa no `accept` e o relatório daquele teste não vale: a conexão foi destravada de fora, sem o header do git. Nessa corrida eram 479 / 34 / 3.

As 33 que continuam falhando:

| Grupo | Quantos | Causa |
|---|---|---|
| Symlink | 18 | `os error 1314`, "O cliente não tem o privilégio necessário." Cobre o teste de IPC, três de worktree que param no symlink da skill, e os testes de attach de skill. Um deles (`archived_session_skills`) falha na asserção seguinte, porque o symlink não ficou. Não se ligou o modo de desenvolvedor: é configuração global da máquina |
| `git worktree add` | 6 | `canonicalize()` devolve `\\?\C:\...`. O Git 2.55 recusa `//?/C:/.../.git` com "Invalid argument". O código está em `runs/worktrees.rs`. A frota não cria worktree nesta máquina até isso ser tratado |
| Asserção com `/` | 4 | `Path::join` no Windows usa `\`. Os testes comparam com string Unix (`graphify` duas vezes, tradução de rota, regra `Edit(...)`) |
| `merge` do `PATH` | 2 | `split_paths` no Windows parte em `;`. Os testes passam `PATH` Unix com `:`. O código está certo para o Windows. Os testes não estão atrás de `cfg(unix)` |
| Preview "refused" | 1 | `error_kind` chegou a `ConnectionRefused`. A asserção seguinte exige a substring inglesa `refused`. A mensagem do SO está em português |
| SCM, ciclo completo | 1 | leu `dos\r\n` onde o teste espera `dos\n`. `core.autocrlf=true` global converte no repo temporário do teste |
| Regra de projeto no worktree | 1 | consequência do worktree que não foi criado |

Não se reescreveu teste para ficar verde. Não se mudou `split_paths`, nem o `canonicalize` do worktree, nem a configuração global do git.

### O teste do forge pendurava a suíte

`forge::test::git_manda_el_token_y_no_usa_otro_helper` grava um helper falso em `GIT_CONFIG_GLOBAL` com o caminho de `Path::display()`. No Windows isso é `C:\Users\...`. O git trata `\` como escape e sai com `bad config line 2` sem abrir o HTTP. O `accept` do teste não tem prazo e a suíte não termina. Nesta corrida ficou mais de 6 minutos até a conexão ser destravada de fora. O relatório daquela corrida para este teste não vale: a requisição injetada não levava `Authorization`.

Reprodução à parte, com o caminho em barra normal: o git manda o header `Authorization: Basic ...` do `GIT_CONFIG_*`, não chama o helper, e sai 128 com "terminal prompts disabled". O mecanismo de conta git da app funciona nesta máquina. O que quebrava era só o arquivo de config do teste.

## Correções

1. **Manifesto só do harness de teste.** `build.rs` compila `src-tauri/windows/test-comctl.manifest` (Common Controls 6.0) com `rc.exe` e `lib.exe` para `ade_test_manifest.lib`. `src/lib.rs` referencia essa lib com `#[link(..., +whole-archive)]` apenas em `cfg(all(windows, test))`. O binário da app não herda um segundo manifesto. Dependência de build: `cc` 1, que já estava na árvore. `Cargo.lock` ganhou uma linha. Em edition 2024 o bloco tem que ser `unsafe extern`.

2. **Caminho do helper no teste do forge.** O caminho gravado no gitconfig usa `/`. O teste passa em 0,11 s e deixa de prender o `cargo test`.

3. **`.gitattributes` com `eol=lf`.** Não muda blob que já era LF. Evita o CRLF que derruba os dois testes de frontend.

## Estado atual

- Fork `https://github.com/tonalenar/ADE-AGS`, `origin` nesse fork, `upstream` em `https://github.com/luis3132/ControlCode.git`.
- Branch `feat/ade-ags-bootstrap`, sem merge em `master`.
- App Windows sobe: `controlcode.exe`, janela `controlcode`.
- Instalador NSIS/MSI não foi produzido.
- CLI `ccode.exe` não sai do `app:build` diário. O script avisa: `bun run app:build --release` é que embala CLI e instaladores.
- Skills por symlink e worktree da frota não funcionam nesta máquina até privilégio de symlink e o prefixo `\\?\` serem tratados. Isso fica para uma etapa posterior. Não é bloqueio de compilação.
- `src-tauri/gen/schemas/windows-schema.json` é gerado pelo Tauri e não entra no commit. O upstream versiona os outros schemas, não este.
