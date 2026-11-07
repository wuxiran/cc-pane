//! Bounded, fair nonblocking forwarding for an SSH direct-tcpip channel.
use std::io::{self, ErrorKind, Read, Write};
use std::time::{Duration, Instant};

const BUFFER_SIZE: usize = 16 * 1024;
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);

pub(super) struct ChannelIo {
    channel: ssh2::Channel,
    stream: ssh2::Stream,
}

impl ChannelIo {
    pub(super) fn new(channel: &ssh2::Channel) -> Self {
        Self {
            channel: channel.clone(),
            stream: channel.stream(0),
        }
    }
}

impl Read for ChannelIo {
    fn read(&mut self, data: &mut [u8]) -> io::Result<usize> {
        let count = self.stream.read(data)?;
        // A libssh2 read may process control packets without yielding payload.
        // Only the channel's EOF state is authoritative for an empty read.
        if count == 0 && !data.is_empty() && !self.channel.eof() {
            return Err(ErrorKind::WouldBlock.into());
        }
        Ok(count)
    }
}

impl Write for ChannelIo {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.stream.write(data)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}

struct Pending {
    bytes: [u8; BUFFER_SIZE],
    start: usize,
    end: usize,
    progressed_at: Instant,
}

impl Pending {
    fn new() -> Self {
        Self {
            bytes: [0; BUFFER_SIZE],
            start: 0,
            end: 0,
            progressed_at: Instant::now(),
        }
    }
    fn empty(&self) -> bool {
        self.start == self.end
    }
    fn read_from(&mut self, source: &mut impl Read, open: &mut bool) -> io::Result<bool> {
        if !*open || !self.empty() {
            return Ok(false);
        }
        match source.read(&mut self.bytes) {
            Ok(0) => {
                *open = false;
                Ok(true)
            }
            Ok(count) => {
                self.start = 0;
                self.end = count;
                self.progressed_at = Instant::now();
                Ok(true)
            }
            Err(error) if retryable(&error) => Ok(false),
            Err(error) => Err(error),
        }
    }
    fn write_to(&mut self, sink: &mut impl Write) -> io::Result<bool> {
        if self.empty() {
            return Ok(false);
        }
        match sink.write(&self.bytes[self.start..self.end]) {
            Ok(0) => Err(ErrorKind::WriteZero.into()),
            Ok(count) => {
                self.start += count;
                self.progressed_at = Instant::now();
                Ok(true)
            }
            Err(error) if retryable(&error) => {
                if self.progressed_at.elapsed() >= WRITE_TIMEOUT {
                    return Err(ErrorKind::TimedOut.into());
                }
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }
}

fn retryable(error: &io::Error) -> bool {
    matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted)
}

/// One bidirectional byte relay, advanced one non-blocking round at a time.
///
/// Several relays can share one thread (and therefore one `ssh2::Session`, whose
/// channels must not be driven from two threads at once): see `ssh_port_forward`.
pub(super) struct Relay {
    up: Box<Pending>,
    down: Box<Pending>,
    local_open: bool,
    remote_open: bool,
}

pub(super) enum RelayStep {
    Idle,
    Progressed,
    Finished,
}

impl Relay {
    pub(super) fn new() -> Self {
        Self {
            up: Box::new(Pending::new()),
            down: Box::new(Pending::new()),
            local_open: true,
            remote_open: true,
        }
    }

    pub(super) fn step(
        &mut self,
        local: &mut (impl Read + Write),
        remote: &mut (impl Read + Write),
    ) -> io::Result<RelayStep> {
        // Service both reads even when one write needs EAGAIN/window updates.
        let mut progressed = self.up.read_from(local, &mut self.local_open)?;
        progressed |= self.down.read_from(remote, &mut self.remote_open)?;
        progressed |= self.up.write_to(remote)?;
        progressed |= self.down.write_to(local)?;
        if (!self.local_open || !self.remote_open) && self.up.empty() && self.down.empty() {
            return Ok(RelayStep::Finished);
        }
        Ok(if progressed {
            RelayStep::Progressed
        } else {
            RelayStep::Idle
        })
    }
}

pub(super) fn pump_bidirectional(
    local: &mut (impl Read + Write),
    remote: &mut (impl Read + Write),
) -> io::Result<()> {
    let mut relay = Relay::new();
    loop {
        match relay.step(local, remote)? {
            RelayStep::Finished => return Ok(()),
            RelayStep::Progressed => {}
            RelayStep::Idle => std::thread::sleep(Duration::from_millis(1)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct WindowedPeer {
        incoming: std::io::Cursor<Vec<u8>>,
        outgoing: Vec<u8>,
        read_serviced: bool,
        blocked_writes: usize,
    }
    impl Read for WindowedPeer {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            self.read_serviced = true;
            self.incoming.read(bytes)
        }
    }
    impl Write for WindowedPeer {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if !self.read_serviced {
                self.blocked_writes += 1;
                if self.blocked_writes > 1 {
                    return Err(io::Error::other("reverse read starved"));
                }
                return Err(ErrorKind::WouldBlock.into());
            }
            let count = bytes.len().min(2);
            self.outgoing.extend_from_slice(&bytes[..count]);
            Ok(count)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn reverse_reads_progress_during_backpressure_and_partial_writes_preserve_bytes() {
        let peer = |bytes: &[u8]| WindowedPeer {
            incoming: std::io::Cursor::new(bytes.to_vec()),
            outgoing: Vec::new(),
            read_serviced: false,
            blocked_writes: 0,
        };
        let mut local = peer(b"client handshake");
        let mut remote = peer(b"server handshake");
        pump_bidirectional(&mut local, &mut remote).unwrap();
        assert_eq!(local.outgoing, b"server handshake");
        assert_eq!(remote.outgoing, b"client handshake");
    }
}
