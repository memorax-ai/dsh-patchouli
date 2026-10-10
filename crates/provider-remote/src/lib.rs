use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use patchouli_provider::{
    ChangePage, ChangeQuery, ConsistentRead, EntityCommit, EntityCommitOutcome, EntityKey,
    EntitySnapshot, IdempotencyReadOutcome, IdempotencyRecord, IdempotentCommitOutcome, Provider,
    ProviderCapabilities, ProviderError, ProviderErrorReason, ProviderRecovery, ReadConsistency,
    RetrieveQuery, RetrievedPage, WorkUnit, WorkUnitCommit, WorkUnitCommitOutcome, WorkUnitPublish,
    WorkUnitReadOutcome, WorkUnitRetrieveOutcome,
};
use reqwest::{Client, Url, redirect::Policy};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use subtle::ConstantTimeEq;
use tokio::sync::watch;

// Bump this whenever a serialized provider call, reply, info, or error shape changes.
const REMOTE_PROVIDER_PROTOCOL: u16 = 4;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteProviderInfo {
    pub protocol: u16,
    pub provider: String,
    pub capabilities: ProviderCapabilities,
    pub recovery: ProviderRecovery,
    pub change_retention_seconds: u64,
}

pub struct RemoteProvider {
    endpoint: Url,
    token: String,
    client: Client,
    info: RemoteProviderInfo,
}

impl RemoteProvider {
    pub fn validate_endpoint(endpoint: &str) -> Result<(), ProviderError> {
        normalize_endpoint(endpoint).map(|_| ())
    }

    pub async fn connect(endpoint: &str, token: String) -> Result<Self, ProviderError> {
        if token.is_empty() {
            return Err(ProviderError::new(
                "remote provider token must not be empty",
            ));
        }
        let endpoint = normalize_endpoint(endpoint)?;
        let client = Client::builder()
            .redirect(Policy::none())
            .build()
            .map_err(|error| transport_error("build HTTP client", endpoint.as_str(), error))?;
        let info_url = endpoint
            .join("info")
            .map_err(|error| endpoint_error("provider info", &endpoint, error))?;
        let info: RemoteProviderInfo = send(
            client
                .get(info_url.clone())
                .timeout(Duration::from_secs(30)),
            &token,
            "fetch provider info",
            info_url.as_str(),
        )
        .await?;
        if info.protocol != REMOTE_PROVIDER_PROTOCOL {
            return Err(ProviderError::new(format!(
                "remote provider protocol {} is unsupported",
                info.protocol
            )));
        }
        Ok(Self {
            endpoint,
            token,
            client,
            info,
        })
    }

    async fn call(&self, call: ProviderCall) -> Result<ProviderReply, ProviderError> {
        self.call_with_timeout(call, Some(Duration::from_secs(30)))
            .await
    }

    async fn call_with_timeout(
        &self,
        call: ProviderCall,
        timeout: Option<Duration>,
    ) -> Result<ProviderReply, ProviderError> {
        let operation = call.operation();
        let call_url = self
            .endpoint
            .join("call")
            .map_err(|error| endpoint_error(operation, &self.endpoint, error))?;
        let mut request = self.client.post(call_url.clone()).json(&call);
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        send(request, &self.token, operation, call_url.as_str()).await
    }
}

fn normalize_endpoint(endpoint: &str) -> Result<Url, ProviderError> {
    let mut url = Url::parse(endpoint).map_err(|error| {
        ProviderError::new(format!("invalid remote provider endpoint: {error}"))
    })?;
    match url.scheme() {
        "https" => {}
        "http" if url.host_str().is_some_and(is_loopback_host) => {}
        _ => {
            return Err(ProviderError::new(
                "remote provider endpoints must use HTTPS; HTTP is allowed only for loopback",
            ));
        }
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    url = url.join("provider/v2/").map_err(|error| {
        ProviderError::new(format!("invalid remote provider endpoint path: {error}"))
    })?;
    Ok(url)
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

async fn send<T: DeserializeOwned>(
    request: reqwest::RequestBuilder,
    token: &str,
    operation: &str,
    endpoint: &str,
) -> Result<T, ProviderError> {
    let response = request
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| transport_error(operation, endpoint, error))?;
    let status = response.status();
    if !status.is_success() {
        let fallback_reason = reason_for_status(status);
        let error = response
            .json::<RemoteError>()
            .await
            .unwrap_or_else(|_| RemoteError {
                reason: fallback_reason,
                error: format!("remote provider returned HTTP {status}"),
            });
        let reason = match fallback_reason {
            ProviderErrorReason::Internal => error.reason,
            reason => reason,
        };
        return Err(ProviderError::with_reason(
            reason,
            format!("{operation} at {endpoint} failed: {}", error.error),
        ));
    }
    response.json().await.map_err(|error| {
        ProviderError::new(format!(
            "{operation} at {endpoint} returned an invalid response: {error}"
        ))
    })
}

fn transport_error(operation: &str, endpoint: &str, error: reqwest::Error) -> ProviderError {
    let reason = if error.is_timeout() {
        ProviderErrorReason::DeadlineExceeded
    } else if error.is_connect() || error.is_request() {
        ProviderErrorReason::Unavailable
    } else {
        ProviderErrorReason::Internal
    };
    ProviderError::with_reason(reason, format!("{operation} at {endpoint} failed: {error}"))
}

fn endpoint_error(operation: &str, endpoint: &Url, error: impl std::fmt::Display) -> ProviderError {
    ProviderError::new(format!(
        "cannot resolve {operation} endpoint from {endpoint}: {error}"
    ))
}

fn reason_for_status(status: StatusCode) -> ProviderErrorReason {
    match status {
        StatusCode::UNAUTHORIZED => ProviderErrorReason::Unauthenticated,
        StatusCode::REQUEST_TIMEOUT | StatusCode::GATEWAY_TIMEOUT => {
            ProviderErrorReason::DeadlineExceeded
        }
        StatusCode::BAD_GATEWAY | StatusCode::SERVICE_UNAVAILABLE => {
            ProviderErrorReason::Unavailable
        }
        _ => ProviderErrorReason::Internal,
    }
}

fn unexpected_reply(reply: ProviderReply) -> ProviderError {
    ProviderError::new(format!(
        "remote provider returned an unexpected reply: {reply:?}"
    ))
}

#[async_trait]
impl Provider for RemoteProvider {
    fn kind(&self) -> &'static str {
        "remote"
    }

    fn capabilities(&self) -> ProviderCapabilities {
        self.info.capabilities
    }

    async fn initialize(&self) -> Result<ProviderRecovery, ProviderError> {
        Ok(self.info.recovery)
    }

    async fn health_check(&self) -> Result<(), ProviderError> {
        match self.call(ProviderCall::Health).await? {
            ProviderReply::Unit => Ok(()),
            reply => Err(unexpected_reply(reply)),
        }
    }

    async fn read_entity(
        &self,
        key: &EntityKey,
        consistency: ReadConsistency,
    ) -> Result<ConsistentRead<Option<EntitySnapshot>>, ProviderError> {
        match self
            .call(ProviderCall::ReadEntity {
                key: key.clone(),
                consistency,
            })
            .await?
        {
            ProviderReply::Entity(value) => Ok(value),
            reply => Err(unexpected_reply(reply)),
        }
    }

    async fn read_changes(&self, query: ChangeQuery) -> Result<ChangePage, ProviderError> {
        let query = RemoteChangeQuery {
            scope_json: query.scope_json,
            entity_types: query.entity_types,
            entity_ids: query.entity_ids,
            after_cursor: query.after_cursor,
            limit: query.limit,
        };
        match self.call(ProviderCall::ReadChanges(query)).await? {
            ProviderReply::Changes(value) => Ok(value),
            reply => Err(unexpected_reply(reply)),
        }
    }

    async fn wait_for_changes(
        &self,
        scope_json: &str,
        after_cursor: u64,
    ) -> Result<(), ProviderError> {
        match self
            .call_with_timeout(
                ProviderCall::WaitForChanges {
                    scope_json: scope_json.to_owned(),
                    after_cursor,
                },
                None,
            )
            .await?
        {
            ProviderReply::Unit => Ok(()),
            reply => Err(unexpected_reply(reply)),
        }
    }

    async fn retrieve_entities(
        &self,
        query: RetrieveQuery,
        consistency: ReadConsistency,
    ) -> Result<ConsistentRead<RetrievedPage>, ProviderError> {
        match self
            .call(ProviderCall::RetrieveEntities { query, consistency })
            .await?
        {
            ProviderReply::Retrieved(value) => Ok(value),
            reply => Err(unexpected_reply(reply)),
        }
    }

    async fn commit_entity(
        &self,
        commit: EntityCommit,
    ) -> Result<EntityCommitOutcome, ProviderError> {
        match self.call(ProviderCall::CommitEntity(commit)).await? {
            ProviderReply::EntityCommit(value) => Ok(value),
            reply => Err(unexpected_reply(reply)),
        }
    }

    async fn read_idempotency(
        &self,
        scope_json: &str,
        consistency: ReadConsistency,
        identity_json: &str,
        request_json: &str,
        now_unix_ms: u64,
    ) -> Result<IdempotencyReadOutcome, ProviderError> {
        match self
            .call(ProviderCall::ReadIdempotency {
                scope_json: scope_json.to_owned(),
                consistency,
                identity_json: identity_json.to_owned(),
                request_json: request_json.to_owned(),
                now_unix_ms,
            })
            .await?
        {
            ProviderReply::IdempotencyRead(value) => Ok(value),
            reply => Err(unexpected_reply(reply)),
        }
    }

    async fn read_idempotency_in_work_unit(
        &self,
        work_unit: &WorkUnit,
        consistency: ReadConsistency,
        identity_json: &str,
        request_json: &str,
        now_unix_ms: u64,
        allow_replay: bool,
    ) -> Result<IdempotencyReadOutcome, ProviderError> {
        match self
            .call(ProviderCall::ReadIdempotencyInWorkUnit {
                work_unit: work_unit.clone(),
                consistency,
                identity_json: identity_json.to_owned(),
                request_json: request_json.to_owned(),
                now_unix_ms,
                allow_replay,
            })
            .await?
        {
            ProviderReply::IdempotencyRead(value) => Ok(value),
            reply => Err(unexpected_reply(reply)),
        }
    }

    async fn commit_entity_idempotent(
        &self,
        commit: EntityCommit,
        idempotency: IdempotencyRecord,
        now_unix_ms: u64,
    ) -> Result<IdempotentCommitOutcome, ProviderError> {
        match self
            .call(ProviderCall::CommitEntityIdempotent {
                commit,
                idempotency,
                now_unix_ms,
            })
            .await?
        {
            ProviderReply::IdempotentCommit(value) => Ok(value),
            reply => Err(unexpected_reply(reply)),
        }
    }

    async fn read_entity_in_work_unit(
        &self,
        work_unit: &WorkUnit,
        key: &EntityKey,
        consistency: ReadConsistency,
    ) -> Result<WorkUnitReadOutcome, ProviderError> {
        match self
            .call(ProviderCall::ReadEntityInWorkUnit {
                work_unit: work_unit.clone(),
                key: key.clone(),
                consistency,
            })
            .await?
        {
            ProviderReply::WorkUnitRead(value) => Ok(value),
            reply => Err(unexpected_reply(reply)),
        }
    }

    async fn retrieve_entities_in_work_unit(
        &self,
        work_unit: &WorkUnit,
        query: RetrieveQuery,
        consistency: ReadConsistency,
    ) -> Result<WorkUnitRetrieveOutcome, ProviderError> {
        match self
            .call(ProviderCall::RetrieveEntitiesInWorkUnit {
                work_unit: work_unit.clone(),
                query,
                consistency,
            })
            .await?
        {
            ProviderReply::WorkUnitRetrieve(value) => Ok(value),
            reply => Err(unexpected_reply(reply)),
        }
    }

    async fn commit_entity_in_work_unit(
        &self,
        commit: WorkUnitCommit,
    ) -> Result<WorkUnitCommitOutcome, ProviderError> {
        match self
            .call(ProviderCall::CommitEntityInWorkUnit(commit))
            .await?
        {
            ProviderReply::WorkUnitCommit(value) => Ok(value),
            reply => Err(unexpected_reply(reply)),
        }
    }

    async fn publish_work_unit(
        &self,
        publish: WorkUnitPublish,
    ) -> Result<WorkUnitCommitOutcome, ProviderError> {
        match self.call(ProviderCall::PublishWorkUnit(publish)).await? {
            ProviderReply::WorkUnitCommit(value) => Ok(value),
            reply => Err(unexpected_reply(reply)),
        }
    }

    async fn checkpoint(&self) -> Result<(), ProviderError> {
        match self.call(ProviderCall::Checkpoint).await? {
            ProviderReply::Unit => Ok(()),
            reply => Err(unexpected_reply(reply)),
        }
    }

    async fn shutdown(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

#[derive(Clone)]
struct ProviderServerState {
    provider: Arc<dyn Provider>,
    token: Arc<str>,
    info: RemoteProviderInfo,
    change_retention_ms: u64,
    shutdown: watch::Receiver<bool>,
}

pub fn remote_provider_router(
    provider: Arc<dyn Provider>,
    token: String,
    recovery: ProviderRecovery,
    change_retention_seconds: u64,
    shutdown: watch::Receiver<bool>,
) -> Result<Router, ProviderError> {
    if token.is_empty() {
        return Err(ProviderError::new(
            "remote provider token must not be empty",
        ));
    }
    if change_retention_seconds == 0 {
        return Err(ProviderError::new(
            "remote provider change retention must be greater than zero",
        ));
    }
    let change_retention_ms = change_retention_seconds
        .checked_mul(1_000)
        .ok_or_else(|| ProviderError::new("remote provider change retention is too large"))?;
    let info = RemoteProviderInfo {
        protocol: REMOTE_PROVIDER_PROTOCOL,
        provider: provider.kind().to_owned(),
        capabilities: provider.capabilities(),
        recovery,
        change_retention_seconds,
    };
    let state = ProviderServerState {
        provider,
        token: token.into(),
        info,
        change_retention_ms,
        shutdown,
    };
    Ok(Router::new()
        .route("/provider/v2/info", get(provider_info))
        .route("/provider/v2/call", post(provider_call))
        .with_state(state))
}

async fn provider_info(State(state): State<ProviderServerState>, headers: HeaderMap) -> Response {
    if !authenticated(&headers, &state.token) {
        return remote_failure(
            StatusCode::UNAUTHORIZED,
            ProviderErrorReason::Unauthenticated,
            "unauthenticated remote provider request",
        );
    }
    Json(state.info).into_response()
}

async fn provider_call(
    State(state): State<ProviderServerState>,
    headers: HeaderMap,
    Json(call): Json<ProviderCall>,
) -> Response {
    if !authenticated(&headers, &state.token) {
        return remote_failure(
            StatusCode::UNAUTHORIZED,
            ProviderErrorReason::Unauthenticated,
            "unauthenticated remote provider request",
        );
    }
    match execute_call(
        state.provider.as_ref(),
        call,
        state.change_retention_ms,
        state.shutdown.clone(),
    )
    .await
    {
        Ok(reply) => Json(reply).into_response(),
        Err(error) => (
            status_for_reason(error.reason()),
            Json(RemoteError {
                reason: error.reason(),
                error: error.to_string(),
            }),
        )
            .into_response(),
    }
}

fn authenticated(headers: &HeaderMap, token: &str) -> bool {
    let Some(value) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let expected = format!("Bearer {token}");
    value.len() == expected.len() && bool::from(value.as_bytes().ct_eq(expected.as_bytes()))
}

fn remote_failure(status: StatusCode, reason: ProviderErrorReason, message: &str) -> Response {
    (
        status,
        Json(RemoteError {
            reason,
            error: message.to_owned(),
        }),
    )
        .into_response()
}

fn status_for_reason(reason: ProviderErrorReason) -> StatusCode {
    match reason {
        ProviderErrorReason::Unauthenticated => StatusCode::UNAUTHORIZED,
        ProviderErrorReason::DeadlineExceeded => StatusCode::REQUEST_TIMEOUT,
        ProviderErrorReason::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        ProviderErrorReason::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn execute_call(
    provider: &dyn Provider,
    call: ProviderCall,
    change_retention_ms: u64,
    mut shutdown: watch::Receiver<bool>,
) -> Result<ProviderReply, ProviderError> {
    Ok(match call {
        ProviderCall::Health => {
            provider.health_check().await?;
            ProviderReply::Unit
        }
        ProviderCall::ReadEntity { key, consistency } => {
            ProviderReply::Entity(provider.read_entity(&key, consistency).await?)
        }
        ProviderCall::ReadChanges(query) => {
            let query = ChangeQuery {
                scope_json: query.scope_json,
                entity_types: query.entity_types,
                entity_ids: query.entity_ids,
                after_cursor: query.after_cursor,
                limit: query.limit,
                retained_after_unix_ms: unix_time_ms().saturating_sub(change_retention_ms),
            };
            ProviderReply::Changes(provider.read_changes(query).await?)
        }
        ProviderCall::WaitForChanges {
            scope_json,
            after_cursor,
        } => {
            if *shutdown.borrow() {
                return Err(provider_shutting_down());
            }
            tokio::select! {
                result = provider.wait_for_changes(&scope_json, after_cursor) => result?,
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        return Err(provider_shutting_down());
                    }
                }
            }
            ProviderReply::Unit
        }
        ProviderCall::RetrieveEntities { query, consistency } => {
            ProviderReply::Retrieved(provider.retrieve_entities(query, consistency).await?)
        }
        ProviderCall::CommitEntity(commit) => {
            ProviderReply::EntityCommit(provider.commit_entity(commit).await?)
        }
        ProviderCall::ReadIdempotency {
            scope_json,
            consistency,
            identity_json,
            request_json,
            now_unix_ms,
        } => ProviderReply::IdempotencyRead(
            provider
                .read_idempotency(
                    &scope_json,
                    consistency,
                    &identity_json,
                    &request_json,
                    now_unix_ms,
                )
                .await?,
        ),
        ProviderCall::ReadIdempotencyInWorkUnit {
            work_unit,
            consistency,
            identity_json,
            request_json,
            now_unix_ms,
            allow_replay,
        } => ProviderReply::IdempotencyRead(
            provider
                .read_idempotency_in_work_unit(
                    &work_unit,
                    consistency,
                    &identity_json,
                    &request_json,
                    now_unix_ms,
                    allow_replay,
                )
                .await?,
        ),
        ProviderCall::CommitEntityIdempotent {
            commit,
            idempotency,
            now_unix_ms,
        } => ProviderReply::IdempotentCommit(
            provider
                .commit_entity_idempotent(commit, idempotency, now_unix_ms)
                .await?,
        ),
        ProviderCall::ReadEntityInWorkUnit {
            work_unit,
            key,
            consistency,
        } => ProviderReply::WorkUnitRead(
            provider
                .read_entity_in_work_unit(&work_unit, &key, consistency)
                .await?,
        ),
        ProviderCall::RetrieveEntitiesInWorkUnit {
            work_unit,
            query,
            consistency,
        } => ProviderReply::WorkUnitRetrieve(
            provider
                .retrieve_entities_in_work_unit(&work_unit, query, consistency)
                .await?,
        ),
        ProviderCall::CommitEntityInWorkUnit(commit) => {
            ProviderReply::WorkUnitCommit(provider.commit_entity_in_work_unit(commit).await?)
        }
        ProviderCall::PublishWorkUnit(publish) => {
            ProviderReply::WorkUnitCommit(provider.publish_work_unit(publish).await?)
        }
        ProviderCall::Checkpoint => {
            provider.checkpoint().await?;
            ProviderReply::Unit
        }
    })
}

fn provider_shutting_down() -> ProviderError {
    ProviderError::with_reason(
        ProviderErrorReason::Unavailable,
        "remote provider is shutting down",
    )
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Serialize, Deserialize)]
struct RemoteChangeQuery {
    scope_json: String,
    entity_types: Option<Vec<String>>,
    entity_ids: Option<Vec<String>>,
    after_cursor: u64,
    limit: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
enum ProviderCall {
    Health,
    ReadEntity {
        key: EntityKey,
        consistency: ReadConsistency,
    },
    ReadChanges(RemoteChangeQuery),
    WaitForChanges {
        scope_json: String,
        after_cursor: u64,
    },
    RetrieveEntities {
        query: RetrieveQuery,
        consistency: ReadConsistency,
    },
    CommitEntity(EntityCommit),
    ReadIdempotency {
        scope_json: String,
        consistency: ReadConsistency,
        identity_json: String,
        request_json: String,
        now_unix_ms: u64,
    },
    ReadIdempotencyInWorkUnit {
        work_unit: WorkUnit,
        consistency: ReadConsistency,
        identity_json: String,
        request_json: String,
        now_unix_ms: u64,
        allow_replay: bool,
    },
    CommitEntityIdempotent {
        commit: EntityCommit,
        idempotency: IdempotencyRecord,
        now_unix_ms: u64,
    },
    ReadEntityInWorkUnit {
        work_unit: WorkUnit,
        key: EntityKey,
        consistency: ReadConsistency,
    },
    RetrieveEntitiesInWorkUnit {
        work_unit: WorkUnit,
        query: RetrieveQuery,
        consistency: ReadConsistency,
    },
    CommitEntityInWorkUnit(WorkUnitCommit),
    PublishWorkUnit(WorkUnitPublish),
    Checkpoint,
}

impl ProviderCall {
    fn operation(&self) -> &'static str {
        match self {
            Self::Health => "health check",
            Self::ReadEntity { .. } => "read entity",
            Self::ReadChanges(_) => "read changes",
            Self::WaitForChanges { .. } => "wait for changes",
            Self::RetrieveEntities { .. } => "retrieve entities",
            Self::CommitEntity(_) => "commit entity",
            Self::ReadIdempotency { .. } => "read idempotency",
            Self::ReadIdempotencyInWorkUnit { .. } => "read work-unit idempotency",
            Self::CommitEntityIdempotent { .. } => "commit idempotent entity",
            Self::ReadEntityInWorkUnit { .. } => "read entity in work unit",
            Self::RetrieveEntitiesInWorkUnit { .. } => "retrieve entities in work unit",
            Self::CommitEntityInWorkUnit(_) => "commit entity in work unit",
            Self::PublishWorkUnit(_) => "publish work unit",
            Self::Checkpoint => "checkpoint provider",
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "result", content = "data", rename_all = "snake_case")]
enum ProviderReply {
    Unit,
    Entity(ConsistentRead<Option<EntitySnapshot>>),
    Changes(ChangePage),
    Retrieved(ConsistentRead<RetrievedPage>),
    EntityCommit(EntityCommitOutcome),
    IdempotencyRead(IdempotencyReadOutcome),
    IdempotentCommit(IdempotentCommitOutcome),
    WorkUnitRead(WorkUnitReadOutcome),
    WorkUnitRetrieve(WorkUnitRetrieveOutcome),
    WorkUnitCommit(WorkUnitCommitOutcome),
}

#[derive(Serialize, Deserialize)]
struct RemoteError {
    reason: ProviderErrorReason,
    error: String,
}
