# Entrega de missões em terminais

Missões executadas em terminais não têm um processo supervisionado que possa reportar o
resultado dos testes. Ao finalizar uma missão desse tipo, a ADE pede que o usuário informe
se os testes passaram, falharam ou não foram executados. Esse resultado é uma declaração do
usuário; a ADE não executa comandos de teste nos terminais.

O número ou URL de um PR é opcional. Deixe o campo vazio quando nenhum PR foi aberto. Com
um PR informado e testes aprovados, a ADE roda `gh pr view <PR> --json statusCheckRollup`
no diretório da missão. A consulta é somente leitura e tem timeout de 30 segundos. Só conta
como verde quando todos os checks retornados estão em sucesso ou neutro. Sem
checks, com checks pendentes, falhos, ou sem acesso ao GitHub CLI, a entrega não é validada.

O estado fica `done` quando os testes passaram e não há PR, ou quando os checks do PR estão
verdes. Nos demais casos, a missão recebe o estado separado `done_without_delivery`. A tela
de detalhes registra o resultado dos testes, a referência do PR, o estado do CI e quando a
consulta foi feita. Um PR inválido não fecha a missão; o usuário pode corrigir o campo.

A migration v27 adiciona `mission_terminal_deliveries`, inicialmente vazia. Ela não reescreve
nenhum estado histórico. Missões antigas `done`, runs supervisionados e seus critérios de
conclusão continuam iguais; a evidência só é criada pelo fluxo novo de finalização em
terminais.
