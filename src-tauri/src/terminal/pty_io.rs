//! Escrita e leitura não bloqueantes no mestre de um PTY (unix).
//!
//! Um `write` num pty cujo escravo não lê pode ficar preso para sempre, e o `write_all` da thread de escrita ficaria
//! preso junto. Aqui o descritor fica não bloqueante, e a espera é um `poll` que também acorda com o cancelamento:
//! fechar a fila escreve um byte no pipe de cancelamento, e a escrita presa volta com erro, mesmo que outro processo
//! segure o escravo.
//!
//! O estado `O_NONBLOCK` pertence à descrição do arquivo, e todos os dups dela compartilham. Por isso o leitor
//! também precisa de `poll`, e não pode ser o leitor bloqueante do portable-pty.

use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;

/// Põe o descritor em modo não bloqueante (vale para todos os dups dele).
pub(crate) fn tornar_nao_bloqueante(fd: RawFd) -> io::Result<()> {
    // SAFETY: `fcntl` com F_GETFL/F_SETFL só lê e escreve as flags de um descritor que o chamador já tem.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: mesmo descritor; só acrescenta O_NONBLOCK às flags que ele já tinha.
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Um dup do descritor, que pertence ao chamador e é fechado quando ele cai.
pub(crate) fn duplicar(fd: RawFd) -> io::Result<OwnedFd> {
    // SAFETY: `dup` devolve um descritor novo, que nenhum outro dono usa; `OwnedFd` passa a possuí-lo.
    let novo = unsafe { libc::dup(fd) };
    if novo < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `novo` é um descritor válido recém-criado, e este é o único dono dele.
    Ok(unsafe { OwnedFd::from_raw_fd(novo) })
}

/// `true` se o cancelamento já foi sinalizado (o byte fica no pipe, então a checagem é sem espera).
fn cancelado(cancela: &UnixStream) -> io::Result<bool> {
    let mut pfd = libc::pollfd { fd: cancela.as_raw_fd(), events: libc::POLLIN, revents: 0 };
    // SAFETY: `pfd` é um `pollfd` válido; `nfds` é 1; timeout 0 não espera.
    let pronto = unsafe { libc::poll(&mut pfd, 1, 0) };
    if pronto < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(pronto > 0)
}

/// Escritor sobre um descritor não bloqueante. Quando o buffer enche, espera pelo descritor ou pelo cancelamento.
pub(crate) struct EscritorCancelavel {
    fd: OwnedFd,
    cancela: UnixStream,
}

impl EscritorCancelavel {
    pub(crate) fn novo(fd: OwnedFd, cancela: UnixStream) -> Self {
        Self { fd, cancela }
    }
}

impl Write for EscritorCancelavel {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        loop {
            if cancelado(&self.cancela)? {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "escrita cancelada: a sessão foi removida"));
            }
            // SAFETY: `buf` é uma fatia válida, e o descritor é o do `OwnedFd` que este escritor possui.
            let n = unsafe { libc::write(self.fd.as_raw_fd(), buf.as_ptr().cast(), buf.len()) };
            if n >= 0 {
                return Ok(n as usize);
            }
            let erro = io::Error::last_os_error();
            match erro.kind() {
                io::ErrorKind::Interrupted => continue,
                io::ErrorKind::WouldBlock => esperar(self.fd.as_raw_fd(), libc::POLLOUT, &self.cancela)?,
                _ => return Err(erro),
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Espera o descritor ficar pronto para `evento`, ou o cancelamento acordar a espera.
fn esperar(fd: RawFd, evento: libc::c_short, cancela: &UnixStream) -> io::Result<()> {
    let mut pfds = [
        libc::pollfd { fd, events: evento, revents: 0 },
        libc::pollfd { fd: cancela.as_raw_fd(), events: libc::POLLIN, revents: 0 },
    ];
    // SAFETY: `pfds` tem 2 entradas válidas que vivem durante a chamada; timeout -1 espera sem prazo, e o
    // cancelamento é uma das entradas, então a espera sempre acorda quando a fila é fechada.
    let r = unsafe { libc::poll(pfds.as_mut_ptr(), 2, -1) };
    if r < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Leitor sobre um descritor não bloqueante: espera a saída chegar, sem ocupar o thread com `read` bloqueante.
pub(crate) struct LeitorNaoBloqueante {
    fd: OwnedFd,
}

impl LeitorNaoBloqueante {
    pub(crate) fn novo(fd: OwnedFd) -> Self {
        Self { fd }
    }
}

impl Read for LeitorNaoBloqueante {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            // SAFETY: `buf` é uma fatia válida, e o descritor é o do `OwnedFd` que este leitor possui.
            let n = unsafe { libc::read(self.fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
            if n >= 0 {
                return Ok(n as usize);
            }
            let erro = io::Error::last_os_error();
            match erro.kind() {
                io::ErrorKind::Interrupted => continue,
                io::ErrorKind::WouldBlock => {
                    let mut pfd = libc::pollfd { fd: self.fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
                    // SAFETY: `pfd` é um `pollfd` válido; `nfds` é 1; a espera acaba quando há dados, EOF ou erro.
                    let r = unsafe { libc::poll(&mut pfd, 1, -1) };
                    if r < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                        return Err(io::Error::last_os_error());
                    }
                }
                _ => return Err(erro),
            }
        }
    }
}
