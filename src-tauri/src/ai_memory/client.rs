use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::de::DeserializeOwned;

use super::types::*;
use crate::util::{external_path, path_env, spawn};

const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT: usize = 2 * 1024 * 1024;
const INSTALL: &str = "Instale manualmente o ai-memory 3.3.0 ou superior pela release oficial: https://github.com/akitaonrails/ai-memory/releases. Confira o checksum publicado e disponibilize o binário no PATH. O ADE não instala nem inicia serviços.";

pub(super) struct Client {
    program: Option<PathBuf>,
    cwd: PathBuf,
    pub(super) timeout: Duration,
}

/// Lista fechada: nenhum argumento pode selecionar uma operação de escrita.
pub(super) enum Read {
    Status,
    Handoffs,
    Recent,
    Search(String),
    Page(String),
    Projects,
}

impl Read {
    fn args(&self) -> Result<Vec<String>, String> {
        let args: Vec<&str> = match self {
            Self::Status => vec!["status", "--json"],
            Self::Handoffs => vec!["handoffs", "--json", "--limit", "50"],
            Self::Recent => vec!["recent", "--json", "--limit", "50"],
            Self::Projects => vec!["list-projects", "--json"],
            Self::Search(query) => {
                if query.trim().is_empty() || query.len() > 4096 || query.contains('\0') {
                    return Err("Informe uma busca de 1 a 4096 bytes.".into());
                }
                // O terminador impede uma consulta como `--expire-all` virar opção.
                vec!["search", "--json", "--limit", "50", "--", query]
            }
            Self::Page(path) => {
                if path.is_empty()
                    || path.len() > 1024
                    || path.contains(['\\', '\0', ':'])
                    || Path::new(path)
                        .components()
                        .any(|c| !matches!(c, Component::Normal(_)))
                {
                    return Err("Informe um caminho relativo de página, sem travessia.".into());
                }
                return Ok(vec![
                    "read-page".into(),
                    "--json".into(),
                    format!("--path={path}"),
                ]);
            }
        };
        Ok(args.into_iter().map(String::from).collect())
    }
}

impl Client {
    pub fn installed(cwd: &str) -> Result<Self, String> {
        // Só executa o caminho resolvido: um nome ausente não pode cair num
        // executável homônimo dentro da pasta do projeto no Windows.
        Self::at(path_env::find_program("ai-memory"), PathBuf::from(cwd))
    }

    pub(super) fn at(program: Option<PathBuf>, cwd: PathBuf) -> Result<Self, String> {
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err("A pasta da aba deve ser um diretório absoluto existente.".into());
        }
        Ok(Self {
            program,
            cwd,
            timeout: TIMEOUT,
        })
    }

    fn execute(&self, args: &[String]) -> io::Result<std::process::Output> {
        let program = external_path(
            self.program
                .as_deref()
                .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?,
        );
        let mut command = crate::util::launch::external_command(&program, args)?;
        // O resolvedor nativo considera marker, rotas de home e identidade git.
        // Forçar nomes no ADE divergiria da captura; não lemos esses arquivos.
        let cwd = external_path(&self.cwd);
        command
            .current_dir(&cwd)
            .env("AI_MEMORY_HOST_CWD", &cwd)
            .env_remove("AI_MEMORY_SCOPE_CWD")
            .env("AI_MEMORY_RUN_AUTOWIRE", "false")
            .env("AI_MEMORY_EMBEDDING_PROVIDER", "none");
        spawn::output(&mut command, self.timeout)
    }

    fn version(&self) -> Result<String, Failure> {
        let output = self.execute(&["--version".into()]).map_err(Failure::Io)?;
        if !output.status.success() {
            return Err(Failure::Unavailable);
        }
        if output.stdout.len() > 256 {
            return Err(Failure::Invalid);
        }
        let text = std::str::from_utf8(&output.stdout).map_err(|_| Failure::Invalid)?;
        let mut parts = text.split_whitespace();
        if parts.next() != Some("ai-memory") {
            return Err(Failure::Invalid);
        }
        let version = parts.next().ok_or(Failure::Invalid)?;
        if parts.next().is_some() {
            return Err(Failure::Invalid);
        }
        let (without_build, build) = version
            .split_once('+')
            .map_or((version, None), |(v, b)| (v, Some(b)));
        let (numbers, prerelease) = without_build
            .split_once('-')
            .map_or((without_build, None), |(v, p)| (v, Some(p)));
        if build.is_some_and(str::is_empty) || prerelease.is_some_and(str::is_empty) {
            return Err(Failure::Invalid);
        }
        let numbers = numbers
            .split('.')
            .map(str::parse::<u64>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| Failure::Invalid)?;
        if numbers.len() != 3 {
            return Err(Failure::Invalid);
        }
        if numbers.as_slice() < [3, 3, 0].as_slice()
            || (numbers == [3, 3, 0] && prerelease.is_some())
        {
            return Err(Failure::Outdated(version.to_owned()));
        }
        Ok(version.to_owned())
    }

    fn json<T: DeserializeOwned>(&self, read: Read) -> Result<T, String> {
        let args = read.args()?;
        let output = self.execute(&args).map_err(|_| {
            "Não foi possível consultar o ai-memory (limite de 10 segundos).".to_string()
        })?;
        if !output.status.success() {
            // stderr externo pode conter credenciais: não o reenviamos nem registramos.
            return Err(
                "O ai-memory não respondeu à leitura; confira se o servidor está em execução."
                    .into(),
            );
        }
        if output.stdout.len() > MAX_OUTPUT {
            return Err("A resposta do ai-memory excedeu 2 MiB.".into());
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|_| "O ai-memory retornou JSON incompatível.".into())
    }

    pub fn read<T: DeserializeOwned>(&self, read: Read) -> Result<Untrusted<T>, String> {
        self.version().map_err(|failure| failure.message())?;
        self.json(read).map(Untrusted::new)
    }

    pub fn probe(&self) -> Result<Untrusted<Probe>, String> {
        let mut probe = Probe {
            state: Availability::ServerDown,
            version: None,
            installation_instruction: None,
            status: None,
            sessions_supported: false,
        };
        match self.version() {
            Err(Failure::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                probe.state = Availability::Missing;
                probe.installation_instruction = Some(INSTALL.into());
            }
            Err(Failure::Outdated(version)) => {
                probe.state = Availability::Outdated;
                probe.version = Some(version);
                probe.installation_instruction = Some(INSTALL.into());
            }
            Err(Failure::Invalid) => return Err(Failure::Invalid.message()),
            Err(_) => {}
            Ok(version) => {
                probe.version = Some(version);
                if let Ok(status) = self.json(Read::Status) {
                    probe.status = Some(status);
                    probe.state = Availability::Ok;
                }
            }
        }
        Ok(Untrusted::new(probe))
    }
}

enum Failure {
    Io(io::Error),
    Unavailable,
    Invalid,
    Outdated(String),
}
impl Failure {
    fn message(self) -> String {
        match self {
            Self::Io(error) if error.kind() == io::ErrorKind::NotFound => {
                "ai-memory não encontrado no PATH.".into()
            }
            Self::Outdated(_) => "O conector exige ai-memory 3.3.0 ou superior.".into(),
            Self::Invalid => "Não foi possível reconhecer a versão do ai-memory.".into(),
            _ => "Não foi possível executar o ai-memory (limite de 10 segundos).".into(),
        }
    }
}
