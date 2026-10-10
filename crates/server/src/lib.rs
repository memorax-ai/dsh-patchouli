mod artifact_store;
#[cfg(feature = "sqlite")]
mod provider_config;
mod transport;

use std::{
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use patchouli_backend::{
    ARTIFACT_ENTITY_TYPE, ArtifactDownloadChunkParams, ArtifactDownloadChunkResult,
    ArtifactDownloadChunkResultData, ArtifactPlacement, ArtifactUploadBeginParams,
    ArtifactUploadBeginResult, ArtifactUploadBeginResultData, ArtifactUploadChunkParams,
    ArtifactUploadChunkResult, ArtifactUploadChunkResultData, ArtifactUploadCommitParams,
    ArtifactValue, BackendEngine, BackendError, BackendErrorReason, BackendService,
    ChangesEventData, ChangesEventParams, ClientIdentity, ControlCheckpointResult,
    ControlCheckpointResultData, ControlShutdownResult, ControlShutdownResultData,
    ControlStatusResult, ControlStatusResultData, CreateEntityData, CreateEntityParams,
    DeleteEntityParams, EmptyData, EngineError, EntityRef, EntityVersion, HandshakeParams,
    HandshakeResult, Meta, PROTOCOL_VERSION, ProtocolEntityConflict, ProtocolErrorData,
    ProtocolErrorReason, ReadEntityParams, RequestDeadline, RetrieveEntitiesParams, RpcParams,
    RpcResult, ServerIdentity, ServerLimits, SubscribeChangesParams, SubscribeChangesResult,
    SubscribeChangesResultData, UnsubscribeChangesParams, UnsubscribeChangesResult,
    UnsubscribeChangesResultData, UpdateEntityParams, error_codes, methods,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::{
    io::{
        AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader, Lines, ReadHalf,
        WriteHalf, split,
    },
    sync::{Mutex, watch},
    task::{JoinError, JoinHandle, JoinSet},
};

use artifact_store::{ArtifactStore, ArtifactStoreError, MAX_ARTIFACT_CHUNK_BYTES};

#[cfg(feature = "sqlite")]
pub use provider_config::{
    ProviderConfig, ProviderConfigError, ProviderDefinition, ProviderRouting, load_provider,
};

const SERVER_CAPABILITIES: &[&str] = &["artifacts", "subscriptions"];
const MAX_REQUEST_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug)]
pub struct ServerOptions {
    pub endpoint: String,
    pub artifact_root: PathBuf,
    pub node_id: String,
    pub cluster_id: String,
}

#[derive(Debug, Error)]
pub enum IpcError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid JSON response: {0}")]
    Json(#[from] serde_json::Error),
    #[error("daemon closed the connection before replying")]
    ConnectionClosed,
    #[error("daemon returned JSON-RPC error {code}: {message}")]
    Rpc { code: i64, message: String },
    #[error("daemon response id does not match request id")]
    ResponseIdMismatch,
    #[error("backend engine lifecycle failed: {0}")]
    Engine(#[from] EngineError),
    #[error("artifact store failed: {0}")]
    ArtifactStore(#[from] ArtifactStoreError),
    #[error("{operation}; backend shutdown also failed: {shutdown}")]
    ShutdownAfterError {
        operation: Box<IpcError>,
        shutdown: EngineError,
    },
}

pub struct LocalServer {
    listener: transport::Listener,
    options: ServerOptions,
    started_at_unix_ms: u64,
    active_connections: Arc<AtomicU64>,
    shutdown_tx: watch::Sender<bool>,
    engine: Arc<BackendEngine>,
    artifact_store: Arc<ArtifactStore>,
}

impl LocalServer {
    pub async fn bind(
        options: ServerOptions,
        engine: Arc<BackendEngine>,
    ) -> Result<Self, IpcError> {
        let listener = transport::Listener::bind(&options.endpoint).await?;
        let artifact_store =
            Arc::new(ArtifactStore::open(&options.artifact_root, options.node_id.clone()).await?);
        let (shutdown_tx, _) = watch::channel(false);
        Ok(Self {
            listener,
            options,
            started_at_unix_ms: unix_time_ms(),
            active_connections: Arc::new(AtomicU64::new(0)),
            shutdown_tx,
            engine,
            artifact_store,
        })
    }

    pub async fn run(mut self) -> Result<(), IpcError> {
        let mut shutdown_rx = self.shutdown_tx.subscribe();
        let mut connections = JoinSet::new();
        let shutdown = shutdown_signal();
        tokio::pin!(shutdown);
        let result = loop {
            tokio::select! {
                accepted = self.listener.accept() => {
                    match accepted {
                        Ok(stream) => {
                            let connection = ConnectionState::new(
                                self.options.clone(),
                                self.started_at_unix_ms,
                                Arc::clone(&self.active_connections),
                                self.shutdown_tx.clone(),
                                Arc::clone(&self.engine),
                                Arc::clone(&self.artifact_store),
                            );
                            connections.spawn(connection.serve(stream));
                        }
                        Err(error) => break Err(IpcError::Io(error)),
                    }
                }
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        break Ok(());
                    }
                }
                joined = connections.join_next(), if !connections.is_empty() => {
                    report_connection_result(joined.expect("non-empty JoinSet must yield a task"));
                }
                signal = &mut shutdown => break signal.map_err(IpcError::Io),
            }
        };

        let _ = self.shutdown_tx.send(true);
        while let Some(joined) = connections.join_next().await {
            report_connection_result(joined);
        }
        let shutdown = self.engine.shutdown().await;
        match (result, shutdown) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) => Err(error),
            (Ok(()), Err(error)) => Err(IpcError::Engine(error)),
            (Err(operation), Err(shutdown)) => Err(IpcError::ShutdownAfterError {
                operation: Box::new(operation),
                shutdown,
            }),
        }
    }
}

fn report_connection_result(result: Result<Result<(), IpcError>, JoinError>) {
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("Patchouli connection closed with error: {error}"),
        Err(error) => eprintln!("Patchouli connection task failed: {error}"),
    }
}

pub async fn shutdown_signal() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = terminate.recv() => {},
        }
        Ok(())
    }

    #[cfg(windows)]
    {
        let mut break_signal = tokio::signal::windows::ctrl_break()?;
        let mut close_signal = tokio::signal::windows::ctrl_close()?;
        let mut shutdown_signal = tokio::signal::windows::ctrl_shutdown()?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = break_signal.recv() => {},
            _ = close_signal.recv() => {},
            _ = shutdown_signal.recv() => {},
        }
        Ok(())
    }

    #[cfg(not(any(unix, windows)))]
    tokio::signal::ctrl_c().await
}

struct ConnectionState {
    options: ServerOptions,
    started_at_unix_ms: u64,
    active_connections: Arc<AtomicU64>,
    shutdown_tx: watch::Sender<bool>,
    engine: Arc<BackendEngine>,
    artifact_store: Arc<ArtifactStore>,
}

impl ConnectionState {
    fn new(
        options: ServerOptions,
        started_at_unix_ms: u64,
        active_connections: Arc<AtomicU64>,
        shutdown_tx: watch::Sender<bool>,
        engine: Arc<BackendEngine>,
        artifact_store: Arc<ArtifactStore>,
    ) -> Self {
        Self {
            options,
            started_at_unix_ms,
            active_connections,
            shutdown_tx,
            engine,
            artifact_store,
        }
    }

    async fn serve(self, stream: transport::Stream) -> Result<(), IpcError> {
        self.active_connections.fetch_add(1, Ordering::Relaxed);
        let _connection_guard = ConnectionGuard(Arc::clone(&self.active_connections));
        let (read_half, write_half) = split(stream);
        let writer = Arc::new(Mutex::new(write_half));
        let mut reader = BufReader::new(read_half);
        let mut handshaken = false;
        let mut shutdown_rx = self.shutdown_tx.subscribe();
        let mut subscriptions = BTreeMap::<String, JoinHandle<()>>::new();
        let mut next_subscription_id = 1_u64;

        loop {
            if *shutdown_rx.borrow() {
                break;
            }
            let frame = tokio::select! {
                frame = read_request_frame(&mut reader) => frame?,
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        break;
                    }
                    continue;
                }
            };
            let Some(frame) = frame else {
                break;
            };
            let line = match frame {
                RequestFrame::Line(line) => line,
                RequestFrame::InvalidUtf8 => {
                    write_json_line(
                        &mut *writer.lock().await,
                        &rpc_error(Value::Null, -32700, "parse error"),
                    )
                    .await?;
                    continue;
                }
                RequestFrame::TooLarge => {
                    write_json_line(
                        &mut *writer.lock().await,
                        &rpc_error(Value::Null, -32600, "request exceeds server limit"),
                    )
                    .await?;
                    continue;
                }
            };
            if handshaken
                && self
                    .handle_subscription(
                        &line,
                        &writer,
                        &mut subscriptions,
                        &mut next_subscription_id,
                    )
                    .await?
            {
                continue;
            }
            let (response, shutdown) = self.dispatch(&line, &mut handshaken).await;
            write_json_line(&mut *writer.lock().await, &response).await?;
            if shutdown {
                let _ = self.shutdown_tx.send(true);
                break;
            }
        }
        for (_, task) in subscriptions {
            task.abort();
        }
        Ok(())
    }

    async fn handle_subscription(
        &self,
        line: &str,
        writer: &Arc<Mutex<WriteHalf<transport::Stream>>>,
        subscriptions: &mut BTreeMap<String, JoinHandle<()>>,
        next_subscription_id: &mut u64,
    ) -> Result<bool, IpcError> {
        let Ok(request) = serde_json::from_str::<Value>(line) else {
            return Ok(false);
        };
        let Some(object) = request.as_object() else {
            return Ok(false);
        };
        let Some(method) = object.get("method").and_then(Value::as_str) else {
            return Ok(false);
        };
        if method != methods::CHANGES_SUBSCRIBE && method != methods::CHANGES_UNSUBSCRIBE {
            return Ok(false);
        }
        let id = object.get("id").cloned().unwrap_or(Value::Null);
        if object.get("jsonrpc") != Some(&Value::String("2.0".to_owned()))
            || !matches!(id, Value::Number(_) | Value::String(_))
        {
            return Ok(false);
        }
        let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
        if method == methods::CHANGES_UNSUBSCRIBE {
            let params = match serde_json::from_value::<UnsubscribeChangesParams>(params) {
                Ok(params) => params,
                Err(error) => {
                    write_json_line(
                        &mut *writer.lock().await,
                        &rpc_error(id, -32602, &error.to_string()),
                    )
                    .await?;
                    return Ok(true);
                }
            };
            if let Err(error) =
                RequestDeadline::from_meta(&params.meta).and_then(RequestDeadline::check_now)
            {
                write_json_line(&mut *writer.lock().await, &rpc_backend_error(id, error)).await?;
                return Ok(true);
            }
            let removed = subscriptions
                .remove(&params.data.subscription_id)
                .is_some_and(|task| {
                    task.abort();
                    true
                });
            let result: UnsubscribeChangesResult = RpcResult {
                meta: Meta::new(),
                data: UnsubscribeChangesResultData { removed },
            };
            write_json_line(&mut *writer.lock().await, &rpc_success(id, result)).await?;
            return Ok(true);
        }

        let params = match serde_json::from_value::<SubscribeChangesParams>(params) {
            Ok(params) => params,
            Err(error) => {
                write_json_line(
                    &mut *writer.lock().await,
                    &rpc_error(id, -32602, &error.to_string()),
                )
                .await?;
                return Ok(true);
            }
        };
        let subscription = match self.engine.subscribe(params).await {
            Ok(subscription) => subscription,
            Err(error) => {
                write_json_line(&mut *writer.lock().await, &rpc_backend_error(id, error)).await?;
                return Ok(true);
            }
        };
        let subscription_id = format!("subscription-{}", *next_subscription_id);
        *next_subscription_id += 1;
        let result: SubscribeChangesResult = RpcResult {
            meta: Meta::new(),
            data: SubscribeChangesResultData {
                subscription_id: subscription_id.clone(),
                cursor: subscription.cursor,
            },
        };
        write_json_line(&mut *writer.lock().await, &rpc_success(id, result)).await?;

        let writer = Arc::clone(writer);
        let event_subscription_id = subscription_id.clone();
        let mut stream = subscription.stream;
        subscriptions.insert(
            subscription_id,
            tokio::spawn(async move {
                while let Some(event) = stream.next().await {
                    let Ok(event) = event else {
                        let _ = writer.lock().await.shutdown().await;
                        break;
                    };
                    let params: ChangesEventParams = RpcParams {
                        meta: event.meta,
                        data: ChangesEventData {
                            subscription_id: event_subscription_id.clone(),
                            change: event.change,
                        },
                    };
                    let notification = json!({
                        "jsonrpc": "2.0",
                        "method": methods::CHANGES_EVENT,
                        "params": params,
                    });
                    if write_json_line(&mut *writer.lock().await, &notification)
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }),
        );
        Ok(true)
    }

    async fn dispatch(&self, line: &str, handshaken: &mut bool) -> (Value, bool) {
        let request: Value = match serde_json::from_str(line) {
            Ok(request) => request,
            Err(_) => return (rpc_error(Value::Null, -32700, "parse error"), false),
        };
        let Some(object) = request.as_object() else {
            return (rpc_error(Value::Null, -32600, "invalid request"), false);
        };
        let id = object.get("id").cloned().unwrap_or(Value::Null);
        if object.get("jsonrpc") != Some(&Value::String("2.0".to_owned()))
            || !matches!(id, Value::Number(_) | Value::String(_))
        {
            return (rpc_error(id, -32600, "invalid request"), false);
        }
        let Some(method) = object.get("method").and_then(Value::as_str) else {
            return (rpc_error(id, -32600, "invalid request"), false);
        };
        let params = object.get("params").cloned().unwrap_or_else(|| json!({}));

        if method == methods::HANDSHAKE {
            let params: HandshakeParams = match serde_json::from_value(params) {
                Ok(params) => params,
                Err(error) => return (rpc_error(id, -32602, &error.to_string()), false),
            };
            if !params.protocol_versions.contains(&PROTOCOL_VERSION) {
                return (
                    rpc_error(id, -32006, "protocol version 1 is required"),
                    false,
                );
            }
            let capabilities = SERVER_CAPABILITIES
                .iter()
                .filter(|capability| params.capabilities.iter().any(|item| item == **capability))
                .map(|capability| (*capability).to_owned())
                .collect();
            *handshaken = true;
            let result = HandshakeResult {
                protocol_version: PROTOCOL_VERSION,
                server: ServerIdentity {
                    version: env!("CARGO_PKG_VERSION").to_owned(),
                    cluster_id: self.options.cluster_id.clone(),
                    node_id: self.options.node_id.clone(),
                },
                capabilities,
                limits: ServerLimits {
                    max_request_bytes: MAX_REQUEST_BYTES as u64,
                    max_artifact_chunk_bytes: MAX_ARTIFACT_CHUNK_BYTES as u64,
                    max_result_items: 100,
                    idempotency_retention_seconds: self.engine.idempotency_retention_seconds(),
                    change_retention_seconds: self.engine.change_retention_seconds(),
                },
            };
            return (rpc_success(id, result), false);
        }

        if !*handshaken {
            return (rpc_error(id, -32001, "handshake is required"), false);
        }

        match method {
            methods::CONTROL_STATUS => {
                let params = match serde_json::from_value::<RpcParams<EmptyData>>(params) {
                    Ok(params) => params,
                    Err(error) => return (rpc_error(id, -32602, &error.to_string()), false),
                };
                if let Err(error) =
                    RequestDeadline::from_meta(&params.meta).and_then(RequestDeadline::check_now)
                {
                    return (rpc_backend_error(id, error), false);
                }
                let result: ControlStatusResult = RpcResult {
                    meta: Meta::new(),
                    data: ControlStatusResultData {
                        ready: true,
                        provider: self.engine.provider_kind().to_owned(),
                        generation: self.engine.recovery().generation,
                        recovered_after_unclean_shutdown: self
                            .engine
                            .recovery()
                            .recovered_after_unclean_shutdown,
                        pid: std::process::id(),
                        started_at_unix_ms: self.started_at_unix_ms,
                        active_connections: self.active_connections.load(Ordering::Relaxed),
                    },
                };
                (rpc_success(id, result), false)
            }
            methods::CONTROL_CHECKPOINT => {
                let params = match serde_json::from_value::<RpcParams<EmptyData>>(params) {
                    Ok(params) => params,
                    Err(error) => return (rpc_error(id, -32602, &error.to_string()), false),
                };
                let deadline = match RequestDeadline::from_meta(&params.meta) {
                    Ok(deadline) => deadline,
                    Err(error) => return (rpc_backend_error(id, error), false),
                };
                if let Err(error) = deadline.check_now() {
                    return (rpc_backend_error(id, error), false);
                }
                match self.engine.checkpoint().await {
                    Ok(()) => {
                        if let Err(error) = deadline.check_now() {
                            return (rpc_backend_error(id, error), false);
                        }
                        let result: ControlCheckpointResult = RpcResult {
                            meta: Meta::new(),
                            data: ControlCheckpointResultData { completed: true },
                        };
                        (rpc_success(id, result), false)
                    }
                    Err(error) => (rpc_error(id, -32603, &error.to_string()), false),
                }
            }
            methods::CONTROL_SHUTDOWN => {
                let params = match serde_json::from_value::<RpcParams<EmptyData>>(params) {
                    Ok(params) => params,
                    Err(error) => return (rpc_error(id, -32602, &error.to_string()), false),
                };
                if let Err(error) =
                    RequestDeadline::from_meta(&params.meta).and_then(RequestDeadline::check_now)
                {
                    return (rpc_backend_error(id, error), false);
                }
                let result: ControlShutdownResult = RpcResult {
                    meta: Meta::new(),
                    data: ControlShutdownResultData { accepted: true },
                };
                (rpc_success(id, result), true)
            }
            methods::ARTIFACT_UPLOAD_BEGIN => {
                let params = match serde_json::from_value::<ArtifactUploadBeginParams>(params) {
                    Ok(params) => params,
                    Err(error) => return (rpc_error(id, -32602, &error.to_string()), false),
                };
                if let Err(error) =
                    RequestDeadline::from_meta(&params.meta).and_then(RequestDeadline::check_now)
                {
                    return (rpc_backend_error(id, error), false);
                }
                match self.artifact_store.begin(params.data).await {
                    Ok(upload_id) => {
                        let result: ArtifactUploadBeginResult = RpcResult {
                            meta: Meta::new(),
                            data: ArtifactUploadBeginResultData {
                                upload_id,
                                max_chunk_bytes: MAX_ARTIFACT_CHUNK_BYTES as u64,
                            },
                        };
                        (rpc_success(id, result), false)
                    }
                    Err(error) => (rpc_artifact_error(id, error), false),
                }
            }
            methods::ARTIFACT_UPLOAD_CHUNK => {
                let params = match serde_json::from_value::<ArtifactUploadChunkParams>(params) {
                    Ok(params) => params,
                    Err(error) => return (rpc_error(id, -32602, &error.to_string()), false),
                };
                if let Err(error) =
                    RequestDeadline::from_meta(&params.meta).and_then(RequestDeadline::check_now)
                {
                    return (rpc_backend_error(id, error), false);
                }
                match self
                    .artifact_store
                    .append(
                        &params.data.upload_id,
                        params.data.offset,
                        &params.data.bytes_base64,
                    )
                    .await
                {
                    Ok(next_offset) => {
                        let result: ArtifactUploadChunkResult = RpcResult {
                            meta: Meta::new(),
                            data: ArtifactUploadChunkResultData { next_offset },
                        };
                        (rpc_success(id, result), false)
                    }
                    Err(error) => (rpc_artifact_error(id, error), false),
                }
            }
            methods::ARTIFACT_UPLOAD_COMMIT => {
                let params = match serde_json::from_value::<ArtifactUploadCommitParams>(params) {
                    Ok(params) => params,
                    Err(error) => return (rpc_error(id, -32602, &error.to_string()), false),
                };
                let deadline = match RequestDeadline::from_meta(&params.meta) {
                    Ok(deadline) => deadline,
                    Err(error) => return (rpc_backend_error(id, error), false),
                };
                if let Err(error) = deadline.check_now() {
                    return (rpc_backend_error(id, error), false);
                }
                let (upload, stored) =
                    match self.artifact_store.commit(&params.data.upload_id).await {
                        Ok(committed) => committed,
                        Err(error) => return (rpc_artifact_error(id, error), false),
                    };
                if let Err(error) = deadline.check_now() {
                    return (rpc_backend_error(id, error), false);
                }
                let value = ArtifactValue {
                    media_type: upload.media_type,
                    name: upload.name,
                    byte_length: Some(stored.byte_length),
                    digest: Some(stored.digest),
                    placement: ArtifactPlacement::Managed {
                        provider: stored.provider,
                        key: stored.key,
                    },
                    metadata: upload.metadata,
                };
                let value = match serde_json::to_value(value) {
                    Ok(value) => value,
                    Err(error) => return (rpc_error(id, -32603, &error.to_string()), false),
                };
                match self
                    .engine
                    .create(RpcParams {
                        meta: params.meta,
                        data: CreateEntityData {
                            entity_type: ARTIFACT_ENTITY_TYPE.to_owned(),
                            id: upload.id,
                            value,
                        },
                    })
                    .await
                {
                    Ok(result) => {
                        self.artifact_store.finish(&params.data.upload_id).await;
                        (rpc_success(id, result), false)
                    }
                    Err(error) => (rpc_backend_error(id, error), false),
                }
            }
            methods::ARTIFACT_DOWNLOAD_CHUNK => {
                let params = match serde_json::from_value::<ArtifactDownloadChunkParams>(params) {
                    Ok(params) => params,
                    Err(error) => return (rpc_error(id, -32602, &error.to_string()), false),
                };
                match self.download_artifact_chunk(params).await {
                    Ok(result) => (rpc_success(id, result), false),
                    Err(ArtifactDownloadError::Backend(error)) => {
                        (rpc_backend_error(id, error), false)
                    }
                    Err(ArtifactDownloadError::Store(error)) => {
                        (rpc_artifact_error(id, error), false)
                    }
                    Err(ArtifactDownloadError::Internal(error)) => {
                        (rpc_error(id, -32603, &error), false)
                    }
                }
            }
            methods::ENTITY_CREATE => {
                let params = match serde_json::from_value::<CreateEntityParams>(params) {
                    Ok(params) => params,
                    Err(error) => return (rpc_error(id, -32602, &error.to_string()), false),
                };
                match self.engine.create(params).await {
                    Ok(result) => (rpc_success(id, result), false),
                    Err(error) => (rpc_backend_error(id, error), false),
                }
            }
            methods::ENTITY_READ => {
                let params = match serde_json::from_value::<ReadEntityParams>(params) {
                    Ok(params) => params,
                    Err(error) => return (rpc_error(id, -32602, &error.to_string()), false),
                };
                match self.engine.read(params).await {
                    Ok(result) => (rpc_success(id, result), false),
                    Err(error) => (rpc_backend_error(id, error), false),
                }
            }
            methods::ENTITY_RETRIEVE => {
                let params = match serde_json::from_value::<RetrieveEntitiesParams>(params) {
                    Ok(params) => params,
                    Err(error) => return (rpc_error(id, -32602, &error.to_string()), false),
                };
                match self.engine.retrieve(params).await {
                    Ok(result) => (rpc_success(id, result), false),
                    Err(error) => (rpc_backend_error(id, error), false),
                }
            }
            methods::ENTITY_UPDATE => {
                let params = match serde_json::from_value::<UpdateEntityParams>(params) {
                    Ok(params) => params,
                    Err(error) => return (rpc_error(id, -32602, &error.to_string()), false),
                };
                match self.engine.update(params).await {
                    Ok(result) => (rpc_success(id, result), false),
                    Err(error) => (rpc_backend_error(id, error), false),
                }
            }
            methods::ENTITY_DELETE => {
                let params = match serde_json::from_value::<DeleteEntityParams>(params) {
                    Ok(params) => params,
                    Err(error) => return (rpc_error(id, -32602, &error.to_string()), false),
                };
                match self.engine.delete(params).await {
                    Ok(result) => (rpc_success(id, result), false),
                    Err(error) => (rpc_backend_error(id, error), false),
                }
            }
            _ => (rpc_error(id, -32601, "method not found"), false),
        }
    }

    async fn download_artifact_chunk(
        &self,
        params: ArtifactDownloadChunkParams,
    ) -> Result<ArtifactDownloadChunkResult, ArtifactDownloadError> {
        let deadline = RequestDeadline::from_meta(&params.meta)?;
        deadline.check_now()?;
        let read = self
            .engine
            .read(RpcParams {
                meta: params.meta,
                data: patchouli_backend::ReadEntityData {
                    entity_ref: EntityRef {
                        entity_type: ARTIFACT_ENTITY_TYPE.to_owned(),
                        id: params.data.id,
                    },
                },
            })
            .await?;
        deadline.check_now()?;
        let versions =
            read.data
                .variants
                .iter()
                .map(|variant| match variant {
                    EntityVersion::Active { version, .. }
                    | EntityVersion::Deleted { version, .. } => version.clone(),
                })
                .collect::<Vec<_>>();
        let entity = match &params.data.version {
            Some(version) => read
                .data
                .variants
                .into_iter()
                .find(|variant| match variant {
                    EntityVersion::Active {
                        version: candidate, ..
                    } => candidate == version,
                    EntityVersion::Deleted { .. } => false,
                }),
            None if read.data.variants.len() == 1 => read
                .data
                .variants
                .into_iter()
                .find(|variant| matches!(variant, EntityVersion::Active { .. })),
            None => return Err(BackendError::version_conflict(versions).into()),
        }
        .ok_or_else(|| {
            BackendError::new(
                BackendErrorReason::NotFound,
                "artifact version was not found",
            )
        })?;
        let value = match &entity {
            EntityVersion::Active { value, .. } => {
                serde_json::from_value::<ArtifactValue>(value.clone())
                    .map_err(|error| ArtifactDownloadError::Internal(error.to_string()))?
            }
            EntityVersion::Deleted { .. } => unreachable!("deleted variants are filtered above"),
        };
        let ArtifactPlacement::Managed { provider, key } = &value.placement else {
            return Err(BackendError::new(
                BackendErrorReason::UnsupportedCapability,
                "indexed artifacts are read through their source provider",
            )
            .into());
        };
        if provider != self.artifact_store.provider() {
            return Err(BackendError::new(
                BackendErrorReason::UnsupportedCapability,
                format!("artifact is managed by provider {provider:?}"),
            )
            .into());
        }
        let chunk = self
            .artifact_store
            .read(provider, key, params.data.offset, params.data.max_bytes)
            .await?;
        if value.byte_length != Some(chunk.byte_length)
            || value.digest.as_deref()
                != key
                    .strip_prefix("sha256/")
                    .map(|digest| format!("sha256:{digest}"))
                    .as_deref()
        {
            return Err(ArtifactDownloadError::Internal(
                "managed artifact descriptor does not match stored content".to_owned(),
            ));
        }
        deadline.check_now()?;
        Ok(RpcResult {
            meta: read.meta,
            data: ArtifactDownloadChunkResultData {
                entity,
                offset: params.data.offset,
                next_offset: chunk.next_offset,
                eof: chunk.eof,
                bytes_base64: chunk.bytes_base64,
            },
        })
    }
}

enum RequestFrame {
    Line(String),
    InvalidUtf8,
    TooLarge,
}

async fn read_request_frame(
    reader: &mut (impl AsyncBufRead + Unpin),
) -> Result<Option<RequestFrame>, std::io::Error> {
    let mut frame = Vec::new();
    let mut too_large = false;

    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return if frame.is_empty() && !too_large {
                Ok(None)
            } else if too_large {
                Ok(Some(RequestFrame::TooLarge))
            } else {
                Ok(Some(frame_from_bytes(frame)))
            };
        }

        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let chunk_len = newline.unwrap_or(buffer.len());
        if !too_large && frame.len().saturating_add(chunk_len) <= MAX_REQUEST_BYTES {
            frame.extend_from_slice(&buffer[..chunk_len]);
        } else {
            too_large = true;
            frame.clear();
        }
        let consumed = chunk_len + usize::from(newline.is_some());
        reader.consume(consumed);

        if newline.is_some() {
            return if too_large {
                Ok(Some(RequestFrame::TooLarge))
            } else {
                Ok(Some(frame_from_bytes(frame)))
            };
        }
    }
}

fn frame_from_bytes(frame: Vec<u8>) -> RequestFrame {
    match String::from_utf8(frame) {
        Ok(line) => RequestFrame::Line(line),
        Err(_) => RequestFrame::InvalidUtf8,
    }
}

#[derive(Debug)]
enum ArtifactDownloadError {
    Backend(BackendError),
    Store(ArtifactStoreError),
    Internal(String),
}

impl From<BackendError> for ArtifactDownloadError {
    fn from(error: BackendError) -> Self {
        Self::Backend(error)
    }
}

impl From<ArtifactStoreError> for ArtifactDownloadError {
    fn from(error: ArtifactStoreError) -> Self {
        Self::Store(error)
    }
}

type ClientReader = Lines<BufReader<ReadHalf<transport::Stream>>>;
type ClientWriter = WriteHalf<transport::Stream>;

pub struct LocalClient {
    lines: ClientReader,
    writer: ClientWriter,
    next_id: i64,
    notifications: VecDeque<ChangesEventParams>,
}

impl LocalClient {
    pub async fn connect(
        endpoint: &str,
        client_name: &str,
        client_version: &str,
    ) -> Result<Self, IpcError> {
        Self::connect_with_capabilities(endpoint, client_name, client_version, Vec::new())
            .await
            .map(|(client, _)| client)
    }

    pub async fn connect_with_capabilities(
        endpoint: &str,
        client_name: &str,
        client_version: &str,
        capabilities: Vec<String>,
    ) -> Result<(Self, HandshakeResult), IpcError> {
        let stream = transport::connect(endpoint).await?;
        let (read_half, writer) = split(stream);
        let mut client = Self {
            lines: BufReader::new(read_half).lines(),
            writer,
            next_id: 1,
            notifications: VecDeque::new(),
        };
        let instance_id = format!("{}-{}", std::process::id(), unix_time_ms());
        let handshake = client
            .call::<_, HandshakeResult>(
                methods::HANDSHAKE,
                &HandshakeParams {
                    client: ClientIdentity {
                        name: client_name.to_owned(),
                        version: client_version.to_owned(),
                        instance_id,
                    },
                    protocol_versions: vec![PROTOCOL_VERSION],
                    capabilities,
                },
            )
            .await?;
        Ok((client, handshake))
    }

    pub async fn status(&mut self) -> Result<ControlStatusResult, IpcError> {
        self.call(
            methods::CONTROL_STATUS,
            &RpcParams {
                meta: Meta::new(),
                data: EmptyData::default(),
            },
        )
        .await
    }

    pub async fn shutdown(&mut self) -> Result<ControlShutdownResult, IpcError> {
        self.call(
            methods::CONTROL_SHUTDOWN,
            &RpcParams {
                meta: Meta::new(),
                data: EmptyData::default(),
            },
        )
        .await
    }

    pub async fn checkpoint(&mut self) -> Result<ControlCheckpointResult, IpcError> {
        self.call(
            methods::CONTROL_CHECKPOINT,
            &RpcParams {
                meta: Meta::new(),
                data: EmptyData::default(),
            },
        )
        .await
    }

    pub async fn begin_artifact_upload(
        &mut self,
        params: &ArtifactUploadBeginParams,
    ) -> Result<ArtifactUploadBeginResult, IpcError> {
        self.call(methods::ARTIFACT_UPLOAD_BEGIN, params).await
    }

    pub async fn upload_artifact_chunk(
        &mut self,
        params: &ArtifactUploadChunkParams,
    ) -> Result<ArtifactUploadChunkResult, IpcError> {
        self.call(methods::ARTIFACT_UPLOAD_CHUNK, params).await
    }

    pub async fn commit_artifact_upload(
        &mut self,
        params: &ArtifactUploadCommitParams,
    ) -> Result<patchouli_backend::MutationResult, IpcError> {
        self.call(methods::ARTIFACT_UPLOAD_COMMIT, params).await
    }

    pub async fn download_artifact_chunk(
        &mut self,
        params: &ArtifactDownloadChunkParams,
    ) -> Result<ArtifactDownloadChunkResult, IpcError> {
        self.call(methods::ARTIFACT_DOWNLOAD_CHUNK, params).await
    }

    pub async fn create(
        &mut self,
        params: &CreateEntityParams,
    ) -> Result<patchouli_backend::MutationResult, IpcError> {
        self.call(methods::ENTITY_CREATE, params).await
    }

    pub async fn read(
        &mut self,
        params: &ReadEntityParams,
    ) -> Result<patchouli_backend::ReadEntityResult, IpcError> {
        self.call(methods::ENTITY_READ, params).await
    }

    pub async fn retrieve(
        &mut self,
        params: &RetrieveEntitiesParams,
    ) -> Result<patchouli_backend::RetrieveEntitiesResult, IpcError> {
        self.call(methods::ENTITY_RETRIEVE, params).await
    }

    pub async fn update(
        &mut self,
        params: &UpdateEntityParams,
    ) -> Result<patchouli_backend::MutationResult, IpcError> {
        self.call(methods::ENTITY_UPDATE, params).await
    }

    pub async fn delete(
        &mut self,
        params: &DeleteEntityParams,
    ) -> Result<patchouli_backend::MutationResult, IpcError> {
        self.call(methods::ENTITY_DELETE, params).await
    }

    pub async fn subscribe(
        &mut self,
        params: &SubscribeChangesParams,
    ) -> Result<SubscribeChangesResult, IpcError> {
        self.call(methods::CHANGES_SUBSCRIBE, params).await
    }

    pub async fn unsubscribe(
        &mut self,
        params: &UnsubscribeChangesParams,
    ) -> Result<UnsubscribeChangesResult, IpcError> {
        self.call(methods::CHANGES_UNSUBSCRIBE, params).await
    }

    pub async fn next_change(&mut self) -> Result<ChangesEventParams, IpcError> {
        if let Some(event) = self.notifications.pop_front() {
            return Ok(event);
        }
        let response = self.read_message().await?;
        if response.get("method") == Some(&json!(methods::CHANGES_EVENT)) {
            return serde_json::from_value(response.get("params").cloned().unwrap_or(Value::Null))
                .map_err(IpcError::from);
        }
        Err(IpcError::ResponseIdMismatch)
    }

    async fn call<TParams: Serialize, TResult: DeserializeOwned>(
        &mut self,
        method: &str,
        params: &TParams,
    ) -> Result<TResult, IpcError> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        write_json_line(&mut self.writer, &request).await?;

        let response = loop {
            let response = self.read_message().await?;
            if response.get("method") == Some(&json!(methods::CHANGES_EVENT)) {
                let event =
                    serde_json::from_value(response.get("params").cloned().unwrap_or(Value::Null))?;
                self.notifications.push_back(event);
                continue;
            }
            if response.get("id") != Some(&json!(id)) {
                return Err(IpcError::ResponseIdMismatch);
            }
            break response;
        };
        if let Some(error) = response.get("error") {
            return Err(IpcError::Rpc {
                code: error.get("code").and_then(Value::as_i64).unwrap_or(-32603),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown JSON-RPC error")
                    .to_owned(),
            });
        }
        serde_json::from_value(response.get("result").cloned().unwrap_or(Value::Null))
            .map_err(IpcError::from)
    }

    async fn read_message(&mut self) -> Result<Value, IpcError> {
        let line = self
            .lines
            .next_line()
            .await?
            .ok_or(IpcError::ConnectionClosed)?;
        serde_json::from_str(&line).map_err(IpcError::from)
    }
}

async fn write_json_line(
    writer: &mut (impl AsyncWrite + Unpin),
    value: &Value,
) -> Result<(), IpcError> {
    let mut encoded = serde_json::to_vec(value)?;
    encoded.push(b'\n');
    writer.write_all(&encoded).await?;
    writer.flush().await?;
    Ok(())
}

fn rpc_success(id: Value, result: impl Serialize) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    let reason = match code as i32 {
        error_codes::INVALID_REQUEST => Some(ProtocolErrorReason::InvalidRequest),
        error_codes::UNAUTHENTICATED => Some(ProtocolErrorReason::Unauthenticated),
        error_codes::FORBIDDEN => Some(ProtocolErrorReason::Forbidden),
        error_codes::UNSUPPORTED_CAPABILITY => Some(ProtocolErrorReason::UnsupportedCapability),
        _ => None,
    };
    if let Some(reason) = reason {
        return rpc_protocol_error(id, code as i32, message, reason, None, None);
    }
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

fn rpc_backend_error(id: Value, error: BackendError) -> Value {
    let (code, reason) = match error.reason {
        BackendErrorReason::CursorExpired => (
            error_codes::CURSOR_EXPIRED,
            ProtocolErrorReason::CursorExpired,
        ),
        BackendErrorReason::DeadlineExceeded => (
            error_codes::DEADLINE_EXCEEDED,
            ProtocolErrorReason::DeadlineExceeded,
        ),
        BackendErrorReason::IdempotencyConflict => (
            error_codes::IDEMPOTENCY_CONFLICT,
            ProtocolErrorReason::IdempotencyConflict,
        ),
        BackendErrorReason::InvalidRequest => (
            error_codes::INVALID_REQUEST,
            ProtocolErrorReason::InvalidRequest,
        ),
        BackendErrorReason::NotFound => (error_codes::NOT_FOUND, ProtocolErrorReason::NotFound),
        BackendErrorReason::Overloaded => {
            (error_codes::OVERLOADED, ProtocolErrorReason::Overloaded)
        }
        BackendErrorReason::UnsupportedCapability => (
            error_codes::UNSUPPORTED_CAPABILITY,
            ProtocolErrorReason::UnsupportedCapability,
        ),
        BackendErrorReason::VersionConflict => (
            error_codes::VERSION_CONFLICT,
            ProtocolErrorReason::VersionConflict,
        ),
        BackendErrorReason::WorkUnitExpired => (
            error_codes::WORK_UNIT_EXPIRED,
            ProtocolErrorReason::WorkUnitExpired,
        ),
    };
    let current_versions = (!error.current_versions.is_empty()).then_some(error.current_versions);
    let conflicts = (!error.conflicts.is_empty()).then(|| {
        error
            .conflicts
            .into_iter()
            .map(|conflict| ProtocolEntityConflict {
                entity_ref: conflict.entity_ref,
                current_versions: conflict.current_versions,
            })
            .collect()
    });
    rpc_protocol_error(
        id,
        code,
        &error.message,
        reason,
        current_versions,
        conflicts,
    )
}

fn rpc_artifact_error(id: Value, error: ArtifactStoreError) -> Value {
    match error {
        ArtifactStoreError::Invalid(message) => rpc_error(id, -32602, &message),
        ArtifactStoreError::NotFound => rpc_error(id, -32003, "artifact content was not found"),
        ArtifactStoreError::Io(error) => rpc_error(id, -32603, &error.to_string()),
    }
}

fn rpc_protocol_error(
    id: Value,
    code: i32,
    message: &str,
    reason: ProtocolErrorReason,
    current_versions: Option<Vec<String>>,
    conflicts: Option<Vec<ProtocolEntityConflict>>,
) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message,
            "data": ProtocolErrorData { reason, current_versions, conflicts },
        },
    })
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after the Unix epoch")
        .as_millis() as u64
}

struct ConnectionGuard(Arc<AtomicU64>);

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}
