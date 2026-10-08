# Runtime Windows

Decisões desta etapa. Não muda identificador, banco, updater nem o nome do servidor MCP.

Uma janela cujo título começa com `npm list` ou `bun run dev` durante o `tauri dev` vem do CLI do Tauri ou de um agente externo, não é filho do `ade-ags.exe`.

## Paths entregues ao Git

`Path::canonicalize` no Windows devolve `\\?\C:\...`. O Git 2.55 rejeita esse prefixo em `worktree add` e `worktree remove` (`Invalid argument` ao criar o `.git` do worktree).

A comparação interna continua em `Path` / `PathBuf`, inclusive o `canonicalize`, porque no macOS `/tmp` é um symlink de `/private/tmp` e sem isso o `strip_prefix` falha. A reescrita acontece só na fronteira do `Command`, em `util::external_path`:

- `\\?\C:\...` vira `C:\...` quando o resultado ainda é um caminho Win32 válido;
- `\\?\UNC\servidor\share\...` vira `\\servidor\share\...` (um UNC de verdade);
- um nome reservado (`\\?\C:\CON`) ou um caminho longo demais **não** perde o prefixo — um `replace("\\?\", "")` quebraria esses casos;
- em Linux e macOS a função é identidade.

O worktree guarda a forma que o Git aceitou, para o `worktree remove` usar a mesma string que ficou registrada.

## Skills sem privilégio de symlink

Cada skill tem uma cópia global. O projeto só recebe um montagem dessa cópia. O mecanismo preferido continua sendo um symlink de diretório.

Nesta máquina, criar symlink devolve o erro 1314 (`ERROR_PRIVILEGE_NOT_HELD`). Isso exige Developer Mode ou administrador. A ADE não pode depender disso.

O fallback é um **directory junction** (`IO_REPARSE_TAG_MOUNT_POINT`, o mesmo que `mklink /J`):

1. tenta o symlink;
2. só no erro 1314 cria o junction;
3. qualquer outro erro sobe. Não há cópia silenciosa.

Por que junction e não as alternativas:

- é um montagem ao vivo. Um arquivo escrito na cópia global aparece na hora através do link. Não existe segunda versão para divergir e não há protocolo de sincronização;
- não exige privilégio para um diretório local do usuário;
- hard link não serve para diretório;
- cópia ficaria muda quando a skill global fosse atualizada. Foi descartada.

O junction não é `FileType::is_symlink` no Rust. A app trata symlink e junction como o mesmo montagem: `read_link` devolve a origem, a reconciliação só remove o que aponta para o diretório global de skills, e uma pasta real do usuário continua intocada. Remover o montagem usa `remove_dir` no reparse point, nunca `remove_dir_all`, que apagaria a skill global.

A origem continua sendo o `source_path` gravado na instalação. Não há uma cópia local para identificar.
