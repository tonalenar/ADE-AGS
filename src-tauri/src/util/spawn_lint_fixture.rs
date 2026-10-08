// Fixture do lint de spawn. Não é módulo: o teste lê este arquivo e exige que ele falhe.
// Está fora da varredura da árvore de propósito.

fn violacao_de_exemplo() {
    let _ = std::process::Command::new("cmd");
    let _ = tokio::process::Command::new("powershell");
}
