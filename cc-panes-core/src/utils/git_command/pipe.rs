//! A single owner polls these read ends; no blocking reader threads can outlive
//! a command deadline when a descendant keeps a pipe's write end open.
use std::io::{self, Read};
use std::time::Duration;

#[cfg(unix)]
pub(super) trait Pipe: Read + std::os::fd::AsRawFd {}
#[cfg(unix)]
impl<R: Read + std::os::fd::AsRawFd> Pipe for R {}
#[cfg(windows)]
pub(super) trait Pipe: Read + std::os::windows::io::AsRawHandle {}
#[cfg(windows)]
impl<R: Read + std::os::windows::io::AsRawHandle> Pipe for R {}

pub(super) struct CapturedPipe<R> {
    reader: R,
    pub(super) output: Vec<u8>,
    pub(super) eof: bool,
}

impl<R: Pipe> CapturedPipe<R> {
    pub(super) fn new(reader: R) -> io::Result<Self> {
        prepare(&reader)?;
        Ok(Self {
            reader,
            output: Vec::new(),
            eof: false,
        })
    }

    pub(super) fn poll(&mut self, remaining: usize) -> io::Result<bool> {
        if self.eof {
            return Ok(false);
        }
        let mut chunk = [0; 64 * 1024];
        match read_available(&mut self.reader, &mut chunk) {
            Ok(0) => {
                self.eof = true;
                Ok(false)
            }
            Ok(read) if read > remaining => Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "Command output limit exceeded",
            )),
            Ok(read) => {
                self.output.extend_from_slice(&chunk[..read]);
                Ok(true)
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }
}

#[cfg(unix)]
fn prepare(reader: &impl Pipe) -> io::Result<()> {
    let fd = reader.as_raw_fd();
    // SAFETY: the owned read end remains open; only its file status flags change.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
fn read_available(reader: &mut impl Pipe, chunk: &mut [u8]) -> io::Result<usize> {
    reader.read(chunk)
}

#[cfg(unix)]
pub(super) fn wait_for_data(
    stdout: &CapturedPipe<impl Pipe>,
    stderr: &CapturedPipe<impl Pipe>,
    timeout: Duration,
) -> io::Result<()> {
    let mut descriptors = [
        libc::pollfd {
            fd: if stdout.eof {
                -1
            } else {
                stdout.reader.as_raw_fd()
            },
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: if stderr.eof {
                -1
            } else {
                stderr.reader.as_raw_fd()
            },
            events: libc::POLLIN,
            revents: 0,
        },
    ];
    let millis = timeout.as_millis().min(i32::MAX as u128) as i32;
    // SAFETY: both entries describe live owned read ends (or -1 for EOF); the
    // short finite timeout wakes for data/EOF without delaying high-volume output.
    if unsafe {
        libc::poll(
            descriptors.as_mut_ptr(),
            descriptors.len() as libc::nfds_t,
            millis,
        )
    } < 0
    {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn prepare(_reader: &impl Pipe) -> io::Result<()> {
    Ok(())
}

#[cfg(windows)]
pub(super) fn wait_for_data(
    _stdout: &CapturedPipe<impl Pipe>,
    _stderr: &CapturedPipe<impl Pipe>,
    timeout: Duration,
) -> io::Result<()> {
    std::thread::sleep(timeout);
    Ok(())
}

#[cfg(windows)]
fn read_available(reader: &mut impl Pipe, chunk: &mut [u8]) -> io::Result<usize> {
    use windows::Win32::Foundation::{ERROR_BROKEN_PIPE, ERROR_PIPE_NOT_CONNECTED, HANDLE};
    use windows::Win32::System::Pipes::PeekNamedPipe;
    let mut available = 0;
    // SAFETY: this is the sole reader of a live owned pipe. No competing read can
    // consume the bytes between PeekNamedPipe and read, and no pending read on
    // this handle can make PeekNamedPipe wait for another thread's synchronous I/O.
    let result = unsafe {
        PeekNamedPipe(
            HANDLE(reader.as_raw_handle()),
            None,
            0,
            None,
            Some(&mut available),
            None,
        )
    };
    if let Err(error) = result {
        if error.code() == windows::core::HRESULT::from_win32(ERROR_BROKEN_PIPE.0)
            || error.code() == windows::core::HRESULT::from_win32(ERROR_PIPE_NOT_CONNECTED.0)
        {
            return Ok(0);
        }
        return Err(io::Error::other(error));
    }
    if available == 0 {
        return Err(io::ErrorKind::WouldBlock.into());
    }
    let length = chunk.len().min(available as usize);
    reader.read(&mut chunk[..length])
}
