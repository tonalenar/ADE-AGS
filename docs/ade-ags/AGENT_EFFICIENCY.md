# Eficiência entre agentes

## Ponto 3 — Setup do worktree

Prepare o worktree antes de iniciar uma missão ou abrir um recruit. Confirme o caminho e a branch atribuídos, ligue `node_modules` às dependências compartilhadas quando aplicável e configure o cache Rust na sessão do shell que executará os comandos. Não reutilize o clone principal como diretório de trabalho do agente.

No Windows, use PowerShell. Para esta missão, o worktree já está pronto em `C:\Users\tonz1n\.antigravity\ADE-AGS-e11-p3-worktree-setup`, na branch `feat/etapa11-p3-worktree-setup`, baseada em `origin/master`. O `node_modules` é uma junction para `C:\Users\tonz1n\.antigravity\ADE-AGS\node_modules`. Para outro worktree, ajuste os caminhos e crie a junction somente se `node_modules` ainda não existir:

```powershell
$worktree = 'C:\Users\tonz1n\.antigravity\ADE-AGS-e11-p3-worktree-setup'
$sharedNodeModules = 'C:\Users\tonz1n\.antigravity\ADE-AGS\node_modules'
$nodeModules = Join-Path $worktree 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModules)) {
    New-Item -ItemType Junction -Path $nodeModules -Target $sharedNodeModules | Out-Null
} else {
    $link = Get-Item -LiteralPath $nodeModules
    if ($link.LinkType -ne 'Junction' -or $link.Target -notcontains $sharedNodeModules) {
        throw 'node_modules existe, mas não é a junction compartilhada esperada; pare e confira o worktree.'
    }
}

Set-Location $worktree
$env:CARGO_TARGET_DIR = Join-Path $worktree 'src-tauri\target'

node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
cargo test --manifest-path src-tauri/Cargo.toml --lib floors::test
```

Use `--lib` com um filtro correspondente ao módulo alterado para evitar rodar todos os testes Rust quando isso não for necessário; por exemplo, `cargo test --manifest-path src-tauri/Cargo.toml --lib floors::test`. Por padrão, o recruit aponta `CARGO_TARGET_DIR` para o target compartilhado do clone principal. Compilações simultâneas podem disputar o lock desse target. Se vários agentes precisarem rodar Cargo ao mesmo tempo, inicie a ADE com `ADE_AGS_CARGO_TARGET_DIR=per-worktree`: cada worktree terá seu próprio target, sem essa disputa, ao custo de recompilar as dependências uma vez em cada worktree.

Se uma próxima missão criar outro worktree Windows sem `node_modules`, crie uma junction para a instalação compartilhada antes de abrir o recruit. Preserve uma junction correta que já exista; não remova nem substitua um diretório desconhecido.

No Linux e no CI, instale as dependências no checkout (`bun install --frozen-lockfile`) e deixe Cargo usar `src-tauri/target`, que é o caminho cacheado pelo workflow. Não copie o `CARGO_TARGET_DIR` absoluto do Windows para scripts Linux ou CI. Os comandos Node acima usam caminhos relativos e funcionam nos dois sistemas; para os testes Rust no CI, use `cargo test --manifest-path src-tauri/Cargo.toml --lib` a partir da raiz. Durante trabalho concorrente, `ADE_AGS_CARGO_TARGET_DIR=per-worktree` também pode ser configurado no processo da ADE em Linux/macOS; isso separa os locks, mas recompila as dependências uma vez por worktree.

Inclua no briefing inicial do agente: caminho do worktree, branch e base, shell a usar, estado/alvo do link de dependências, configuração de `CARGO_TARGET_DIR` para aquele sistema e os comandos exatos de validação. Resolva os caminhos antes de abrir a missão ou executar `ags peer recruit`; o agente não deve precisar descobrir nem inferir o setup.
