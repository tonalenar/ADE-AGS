//! Compatibility entry point for the legacy CLI name.
#[path = "cli.rs"]
mod cli;

fn main() -> std::process::ExitCode {
    cli::main()
}
