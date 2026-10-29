//! The end of a dead peer: a connection that takes no bytes for two heartbeat intervals is closed.
//!
//! DSH's Gateway terminates a socket with no activity across two `websocketHeartbeatIntervalMs` intervals, and
//! counts "a downlink write that waited in the full local send buffer and then completed" as activity, so a
//! congested but live link stays connected (dsh-api-gateway README). An SSE stream has no Pong to read, so heddle
//! keeps the half a one-way stream can observe: a write that stays pending — the peer stopped reading and the
//! kernel's send buffer is full — for two intervals fails with `TimedOut`, and hyper closes the connection. Any
//! completed write, however small, is progress and restarts the clock, so a slow link is kept.
//!
//! `src/server/stream.ts` applies the same rule to the TypeScript server's sockets (`StallWatch`).

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::{Instant, Sleep};

/// An IO whose writes fail once they have been pending, without any progress, for `limit`.
pub struct StallGuard<T> {
    inner: T,
    limit: Duration,
    /// When the current run of pending writes began; `None` while writes complete.
    stalled_since: Option<Instant>,
    /// A timer that wakes the writer at the deadline, so a stalled connection is judged without new traffic.
    deadline: Option<Pin<Box<Sleep>>>,
}

impl<T> StallGuard<T> {
    pub fn new(inner: T, limit: Duration) -> Self {
        StallGuard {
            inner,
            limit,
            stalled_since: None,
            deadline: None,
        }
    }

    /// The wrapped IO.
    pub fn get_ref(&self) -> &T {
        &self.inner
    }

    fn progressed(&mut self) {
        self.stalled_since = None;
        self.deadline = None;
    }

    /// Called when the inner IO answered `Pending`: `Ready(Err)` once the stall has lasted `limit`.
    fn pending(&mut self, cx: &mut Context<'_>) -> Poll<io::Error> {
        let now = Instant::now();
        let since = *self.stalled_since.get_or_insert(now);
        let at = since + self.limit;
        if now >= at {
            return Poll::Ready(timed_out(self.limit));
        }
        let timer = self
            .deadline
            .get_or_insert_with(|| Box::pin(tokio::time::sleep_until(at)));
        if timer.as_mut().poll(cx).is_ready() {
            return Poll::Ready(timed_out(self.limit));
        }
        Poll::Pending
    }
}

fn timed_out(limit: Duration) -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        format!(
            "the peer took no bytes for {} ms (two heartbeat intervals)",
            limit.as_millis()
        ),
    )
}

impl<T: AsyncRead + Unpin> AsyncRead for StallGuard<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for StallGuard<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match Pin::new(&mut self.inner).poll_write(cx, buf) {
            Poll::Ready(result) => {
                self.progressed();
                Poll::Ready(result)
            }
            Poll::Pending => self.pending(cx).map(Err),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match Pin::new(&mut self.inner).poll_flush(cx) {
            Poll::Ready(result) => {
                self.progressed();
                Poll::Ready(result)
            }
            Poll::Pending => self.pending(cx).map(Err),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// A listener whose connections are [`StallGuard`]ed.
pub struct GuardedListener<L> {
    inner: L,
    limit: Duration,
}

impl<L> GuardedListener<L> {
    pub fn new(inner: L, limit: Duration) -> Self {
        GuardedListener { inner, limit }
    }
}

impl<L> axum::serve::Listener for GuardedListener<L>
where
    L: axum::serve::Listener,
{
    type Io = StallGuard<L::Io>;
    type Addr = L::Addr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (io, addr) = self.inner.accept().await;
        (StallGuard::new(io, self.limit), addr)
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    /// A writer that never takes a byte, as a peer that stopped reading looks once the send buffer is full.
    struct Stuck;

    impl AsyncWrite for Stuck {
        fn poll_write(self: Pin<&mut Self>, _: &mut Context<'_>, _: &[u8]) -> Poll<io::Result<usize>> {
            Poll::Pending
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn a_write_pending_for_two_intervals_fails_with_timed_out() {
        let mut guarded = StallGuard::new(Stuck, Duration::from_millis(200));
        let started = Instant::now();
        let error = guarded.write_all(b"event: heartbeat\n\n").await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        // The timer woke the writer at the deadline: no further traffic was needed to judge it.
        let elapsed = started.elapsed();
        assert!(elapsed >= Duration::from_millis(200), "{elapsed:?}");
        assert!(elapsed < Duration::from_millis(2000), "{elapsed:?}");
    }

    /// A writer that takes one byte per call, then stalls `stall` before the next — a slow but live link.
    struct Trickle {
        ready_at: Option<Instant>,
        stall: Duration,
    }

    impl AsyncWrite for Trickle {
        fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, _: &[u8]) -> Poll<io::Result<usize>> {
            let now = Instant::now();
            match self.ready_at {
                Some(at) if now < at => {
                    let waker = cx.waker().clone();
                    tokio::spawn(async move {
                        tokio::time::sleep_until(at).await;
                        waker.wake();
                    });
                    Poll::Pending
                }
                _ => {
                    self.ready_at = Some(now + self.stall);
                    Poll::Ready(Ok(1))
                }
            }
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn a_slow_link_that_keeps_taking_bytes_is_kept() {
        // Each byte waits 120 ms — longer than one 100 ms interval, shorter than the 200 ms deadline — and every
        // one completes, so the link is kept however long the whole write takes.
        let mut guarded = StallGuard::new(
            Trickle {
                ready_at: None,
                stall: Duration::from_millis(120),
            },
            Duration::from_millis(200),
        );
        let started = Instant::now();
        guarded.write_all(b"alive").await.expect("a link that makes progress is never cut");
        assert!(started.elapsed() >= Duration::from_millis(400), "the write really was slow");
    }

    #[tokio::test]
    async fn the_listener_wraps_every_connection_it_accepts() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut guarded = GuardedListener::new(listener, Duration::from_millis(4000));
        let _client = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (io, _) = axum::serve::Listener::accept(&mut guarded).await;
        assert_eq!(io.limit, Duration::from_millis(4000));
        assert!(io.get_ref().peer_addr().is_ok());
    }
}
