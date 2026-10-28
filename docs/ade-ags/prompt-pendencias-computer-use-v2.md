Você vai terminar as pendências do plano v2 do computer use com o Jev (piloto do navegador do canvas do ADE AGS: `ags portal act` / `browser_act`).

LEIA PRIMEIRO
- docs/ade-ags/plano-computer-use-jev-v2.md: auditoria, plano e, nas seções 5.1 a 5.11, o que foi feito, os números reais antes/depois e as pendências. É a especificação.
- Código: src/features/browser/jevPilot.ts (o laço do piloto), agentBridge.ts (a ponte e `pilotDeps`), page/runtime.ts e page/snapshotFormat.ts (o runtime injetado na página), src-tauri/src/decisions/browse.rs e browse_rules.rs (as perguntas e regras do Jev), src-tauri/src/decisions/vision.rs (a foto).
- Benchmark: scripts/jev-bench.ts (--list, --sim, --real, --with-expect, --gate), scripts/bench/tasks.ts, scripts/bench-fixture/*.html, resultados em docs/ade-ags/bench/.

ESTADO ATUAL (dev, app instalado b02ef413)
Locais 54/54 (100%), públicas 7/8 (88%), falso «feito» 0, violações 0, 0 travamentos da janela, passo p50 494 ms, consulta ao Jev p50 299 ms.

PENDÊNCIAS (nesta ordem; cada uma com número antes/depois do benchmark real)
1. L12-garantia-na-foto (falso «parou» ×2): o botão «Garantia estendida» só existe na imagem. O piloto toca certo pela foto (a página passa a mostrar GARANTIA ABERTA), mas o Jev responde «fim p=0,01» e o piloto repete o passo e para. Faça o piloto reconhecer que o toque pela foto cumpriu o objetivo quando: o objetivo é imperativo de clicar num controle, a foto apontou com confiança alta, o toque MUDOU a página e nada indica erro. Cuidado para não dar «feito» onde o objetivo tem mais etapas, e mantenha as travas (compra/pagamento não pedido, campo sensível, mesmo ponto duas vezes).
2. P04-saucedemo-checkout (uma das duas repetições para «sem certeza»): ache a causa pelos relatórios em docs/ade-ags/bench/v2-final*-real-publicas.json e corrija. A tarefa deve parar ANTES de finalizar a compra (nunca clique em Finish).
3. Meta de públicas ≥ 90%: rode as públicas com mais repetições (--repeat 4) para sair do ruído de 8 rodadas, e trate o que sobrar. Amazon fica só como sonda, fora dos portões.
4. Fase 6 (visão como reserva): hoje a foto é o último recurso do piloto. Meça quando ela é usada, quanto custa por `act` (consultas e tempo) e mostre isso no relatório do `act`; reveja o tamanho/recorte da foto e o reveal do nó no canvas (item 4 das pendências do relatório da primeira missão). Só implemente o que o número justificar.
5. SÓ SE O USUÁRIO CONFIRMAR O PROVEDOR: 4.4, um modelo pequeno que gera o texto a digitar quando não há `--fill` (JSON {"text": ...} validado, nunca para senha/cartão/token, mesma varredura de segredos, cache descartado após mutação, desligado por padrão). Se não houver confirmação, NÃO faça: registre «aguardando provedor» no relatório.

COMO TRABALHAR
- Branch: crie a sua a partir de origin/dev e abra PR para a dev (commits pequenos). Não mexa no checkout principal do Codex (C:\Users\tonz1n\.antigravity\ADE-AGS).
- Testes antes de cada PR: `bunx tsc --noEmit`, `bunx vitest run` e `cargo test --lib` em src-tauri. Mudou texto de regra em browse_rules.rs? Suba RULES_VERSION e rode o benchmark real antes e depois: uma regra nova já derrubou o P03 uma vez.
- Medir: `bun scripts/jev-bench.ts --sim --repeat 3 --seed 1` (sem custo) para lógica; `--real --with-expect --repeat 2` para o número de verdade. Para o real o app instalado precisa ter o seu código: gere o instalador num worktree separado (`bun scripts/build.mjs --release --target windows-amd64`; antes de cada checkout rode `git checkout -- src-tauri/gen`) e só instale/feche o app com o OK do usuário. NUNCA reinicie o app instalado com missão ou terminais do usuário rodando.
- Rodar o benchmark real: PATH com a pasta do app (`C:\Users\tonz1n\AppData\Local\ADE AGS`, onde está o ags.exe) e `ADE_TAB_ID` de um terminal do app; a janela com o canvas VISÍVEL. Custo do Jev real: uma rodada local completa (27 × 2) usa ~150 a 200 consultas; limite sua sessão a umas 1.000 no total.
- Nunca login real, compra, pagamento ou dado pessoal (mantenha blockedPurchase e sensitiveFilled). Textos de UI e respostas em PT-BR (com en/es nos locales).
- Pegadinha: no PowerShell 5, `ags ... --objective $texto` quebra nas aspas duplas; troque por simples ou use --file.

ENTREGA
1. As correções com testes, em PRs na dev.
2. Rodadas reais antes/depois de cada pendência, em docs/ade-ags/bench/ (v2-final6-*).
3. Atualize as seções 5.x de docs/ade-ags/plano-computer-use-jev-v2.md com o que fez, os números e o que não fez.
4. No fim, diga em poucas linhas: o que foi resolvido, o que não, e o que depende do usuário (provedor do 4.4, OK para instalar).
