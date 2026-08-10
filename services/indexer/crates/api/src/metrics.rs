use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::Instant,
};

use axum::{body::Body, extract::State, http::Request, middleware::Next, response::Response};
use chrono::Utc;

use crate::ApiState;

#[derive(Clone, Default)]
pub struct ApiMetrics {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    requests: AtomicU64,
    errors: AtomicU64,
    active: AtomicUsize,
    latency_micros: AtomicU64,
    query_timeouts: AtomicU64,
    stale_responses: AtomicU64,
    position_sockets: AtomicUsize,
    position_messages: AtomicU64,
    position_resyncs: AtomicU64,
    position_listener_connected: AtomicBool,
    position_listener_reconnects: AtomicU64,
}

pub struct Snapshot {
    pub requests: u64,
    pub errors: u64,
    pub active: usize,
    pub latency_micros: u64,
    pub query_timeouts: u64,
    pub stale_responses: u64,
    pub position_sockets: usize,
    pub position_messages: u64,
    pub position_resyncs: u64,
    pub position_listener_connected: bool,
    pub position_listener_reconnects: u64,
}

impl ApiMetrics {
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            requests: self.inner.requests.load(Ordering::Relaxed),
            errors: self.inner.errors.load(Ordering::Relaxed),
            active: self.inner.active.load(Ordering::Relaxed),
            latency_micros: self.inner.latency_micros.load(Ordering::Relaxed),
            query_timeouts: self.inner.query_timeouts.load(Ordering::Relaxed),
            stale_responses: self.inner.stale_responses.load(Ordering::Relaxed),
            position_sockets: self.inner.position_sockets.load(Ordering::Relaxed),
            position_messages: self.inner.position_messages.load(Ordering::Relaxed),
            position_resyncs: self.inner.position_resyncs.load(Ordering::Relaxed),
            position_listener_connected: self
                .inner
                .position_listener_connected
                .load(Ordering::Relaxed),
            position_listener_reconnects: self
                .inner
                .position_listener_reconnects
                .load(Ordering::Relaxed),
        }
    }

    pub fn record_query_timeout(&self) {
        self.inner.query_timeouts.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_stale_response(&self) {
        self.inner.stale_responses.fetch_add(1, Ordering::Relaxed);
    }

    pub fn position_socket_opened(&self) {
        self.inner.position_sockets.fetch_add(1, Ordering::Relaxed);
    }

    pub fn position_socket_closed(&self) {
        self.inner.position_sockets.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn position_message_sent(&self) {
        self.inner.position_messages.fetch_add(1, Ordering::Relaxed);
    }

    pub fn position_resync(&self) {
        self.inner.position_resyncs.fetch_add(1, Ordering::Relaxed);
    }

    pub fn set_position_listener_connected(&self, connected: bool) {
        self.inner
            .position_listener_connected
            .store(connected, Ordering::Relaxed);
    }

    pub fn position_listener_reconnect(&self) {
        self.inner
            .position_listener_reconnects
            .fetch_add(1, Ordering::Relaxed);
    }
}

pub async fn track(State(state): State<ApiState>, request: Request<Body>, next: Next) -> Response {
    let started = Instant::now();
    state.metrics.inner.requests.fetch_add(1, Ordering::Relaxed);
    state.metrics.inner.active.fetch_add(1, Ordering::Relaxed);
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let response = next.run(request).await;
    state.metrics.inner.active.fetch_sub(1, Ordering::Relaxed);
    let elapsed = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
    state
        .metrics
        .inner
        .latency_micros
        .fetch_add(elapsed, Ordering::Relaxed);
    if response.status().is_client_error() || response.status().is_server_error() {
        state.metrics.inner.errors.fetch_add(1, Ordering::Relaxed);
    }
    println!(
        "{}",
        serde_json::json!({
            "timestamp": Utc::now(),
            "level": "info",
            "service": "leveraged-prediction-api",
            "event": "request_completed",
            "method": method.as_str(),
            "path": path,
            "status": response.status().as_u16(),
            "duration_micros": elapsed,
        })
    );
    response
}
