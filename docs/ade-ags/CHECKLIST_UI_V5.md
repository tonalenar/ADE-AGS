# Checklist de UI ao vivo — complemento do teste v5 (~20 min)

Cobre o que nenhum agente alcançou (ver `RELATORIO_TESTE_V5.md`, "Não coberto"). Faça no app instalado (1.8.7), **sem fechar nem reiniciar**. Marque ✅ passou / ❌ falhou / ➖ não se aplica e anote o que viu.

**Regras:** em Ajustes > Decisões NÃO clique em Salvar, NÃO ligue o modo sombra, NÃO grave chave. Não mexa em Contas.

## 1. Canvas (pt-BR)
- [ ] Clicar num nó: contorno fino com halo (sem borda grossa).
- [ ] Nó selecionado mostra alças de redimensionar; arrastar uma alça redimensiona sem pular.
- [ ] Portas de conexão discretas (aparecem sem poluir); conectar dois nós funciona.
- [ ] Minimapa visível; arrastar nele move a vista; sem nós ele não quebra.
- [ ] Dock e painéis alinhados (sem sobreposição) com a janela normal e maximizada.
- [ ] Botão do olho (Vigia) alterna ligado/desligado e tem tooltip.

## 2. Missões
- [ ] Lista, detalhe e "Nova missão" abrem sem texto cortado sem tooltip.
- [ ] Clicar numa missão **iniciada** abre o canvas com os terminais dela.
- [ ] Missão **falha recente** reaparece com a ação "iniciar" (ou "Tentar novamente") e relança os terminais.
- [ ] Resume que falha reabre o agente.

## 3. Ajustes > Decisões (só olhar)
- [ ] Trocar o provedor para **Laya Studio**: aparece o aviso de privacidade ("Este endereço não é desta máquina…").
- [ ] Trocar para **Jev**: o mesmo aviso aparece.
- [ ] Trocar para provedor local/nenhum: o aviso some.
- [ ] "Testar conexão" não trava a janela (se houver URL já configurada; senão ➖).
- [ ] Sair da seção sem salvar: nada mudou ao voltar.

## 4. Esc e tela cheia
- [ ] Abrir uma tela cheia (Missões, Squads, Skills…) → abrir um seletor/combobox → Esc: fecha só o popup.
- [ ] Mesmo teste, mas **mover o foco com as setas para uma opção da lista** e Esc: a tela cheia deve continuar aberta (se fechar, confirma o achado baixo 2).
- [ ] Sem popup, Esc fecha a tela cheia.

## 5. Outras telas
- [ ] Squads > Criar Squad: seletor de provedor funciona.
- [ ] Ajustes > Contas e Painel de memória: abrem (só olhar).
- [ ] Histórico, Frota e Novo agente: abrem; botões respondem.
- [ ] Botões só de ícone mostram tooltip/nome ao passar o mouse.

## 6. Idiomas (repetir 1 a 5 rapidamente em en e es)
- [ ] Nenhuma chave crua (ex.: `settings.decisions.remoteWarn`) em en.
- [ ] Nenhuma chave crua em es.
- [ ] Textos longos em es/en não estouram botões nem ficam cortados sem tooltip.

## 7. Janela e terminais
- [ ] Maximizar/restaurar e tela cheia nativa: layout íntegro.
- [ ] Abrir terminal Claude, Codex, Antigravity e Shell: nenhum abre em branco.
- [ ] Trocar de aba e voltar: o conteúdo reaparece (aba em segundo plano só monta ao focar — conhecido).

## Como relatar
Para cada ❌: tela, idioma, passos, o que esperava × o que viu. Mande ao Orquestrador para entrar no relatório.
