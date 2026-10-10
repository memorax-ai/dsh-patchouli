use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Weak},
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use patchouli_provider::{
    ChangeQuery, ConsistentRead, EntityCommit, EntityCommitOutcome, EntityKey, EntitySnapshot,
    IdempotencyReadOutcome, IdempotencyRecord, IdempotentCommitOutcome, Provider,
    ProviderCapabilities, ProviderError, ProviderErrorReason, ProviderRecovery, ReadConsistency,
    ReadObservation, SessionConsistency, StoredChangeKind, StoredCrdtChange, StoredCrdtField,
    StoredEntityVersion, StoredVersionState, WorkUnit, WorkUnitCommit, WorkUnitCommitOutcome,
    WorkUnitConflict, WorkUnitExpiryAction, WorkUnitPublish, WorkUnitReadOutcome,
    WorkUnitResolution, WorkUnitRetrieveOutcome,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use thiserror::Error;
use tokio::sync::{Mutex, OwnedMutexGuard};
use uuid::Uuid;

use crate::{
    BackendConfig, BackendError, BackendErrorReason, BackendService, BatchCloseCondition,
    ChangeKind, ChangeRecord, ChangeSubscription, ConflictCandidate, ConflictFallback,
    ConflictMergeRule, ConflictPlan, ConflictStrategy, ConsistencySource, CrdtChange, CrdtDocument,
    CreateEntityParams, DeleteEntityParams, EntityRef, EntityVersion, EntityVersionConflict, Meta,
    MutationData, MutationResult, PolicySelection, PolicySelector, PublicationPolicy,
    PublishedChange, ReadEntityParams, ReadEntityResult, ReadEntityResultData, ReadState,
    RequestDeadline, RetrievalHit, RetrieveEntitiesParams, RetrieveEntitiesResult,
    RetrieveEntitiesResultData, RpcResult, SubscribeChangesParams, UpdateEntityParams,
    query::{encode_cursor, parse_query},
    resolve_prepared_conflict,
};

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("database provider is not ready: {0}")]
    Provider(#[from] ProviderError),
    #[error("database provider does not satisfy backend configuration: {0}")]
    Capability(String),
}

#[derive(Default)]
struct ExecutionLocks {
    by_key: Mutex<BTreeMap<String, Weak<Mutex<()>>>>,
}

impl ExecutionLocks {
    async fn acquire(
        &self,
        selection: &PolicySelection,
        mutation: bool,
    ) -> Result<Vec<OwnedMutexGuard<()>>, BackendError> {
        self.acquire_many(std::slice::from_ref(selection), mutation)
            .await
    }

    async fn acquire_many(
        &self,
        selections: &[PolicySelection],
        mutation: bool,
    ) -> Result<Vec<OwnedMutexGuard<()>>, BackendError> {
        let mut keys = BTreeSet::new();
        for selection in selections {
            if let Some(key) = &selection.consistency.linearization_key {
                keys.insert(serde_json::to_string(key).map_err(invalid_request)?);
            }
            if mutation && let Some(key) = &selection.consistency.commit_ordering_key {
                keys.insert(serde_json::to_string(key).map_err(invalid_request)?);
            }
            if mutation && let Some(key) = &selection.idempotency_key {
                keys.insert(serde_json::to_string(key).map_err(invalid_request)?);
            }
        }
        let locks = {
            let mut known = self.by_key.lock().await;
            known.retain(|_, lock| lock.strong_count() > 0);
            keys.into_iter()
                .map(|key| {
                    if let Some(lock) = known.get(&key).and_then(Weak::upgrade) {
                        lock
                    } else {
                        let lock = Arc::new(Mutex::new(()));
                        known.insert(key, Arc::downgrade(&lock));
                        lock
                    }
                })
                .collect::<Vec<_>>()
        };
        let mut guards = Vec::with_capacity(locks.len());
        for lock in locks {
            guards.push(lock.lock_owned().await);
        }
        Ok(guards)
    }
}

pub struct BackendEngine {
    config: BackendConfig,
    selector: PolicySelector,
    provider: Arc<dyn Provider>,
    recovery: ProviderRecovery,
    execution_locks: ExecutionLocks,
}

impl BackendEngine {
    pub async fn start(
        config: BackendConfig,
        provider: Arc<dyn Provider>,
    ) -> Result<Self, EngineError> {
        validate_provider_capabilities(&config, provider.capabilities())?;
        let recovery = provider.initialize().await?;
        if let Err(health_error) = provider.health_check().await {
            let reason = health_error.reason();
            return match provider.shutdown().await {
                Ok(()) => Err(EngineError::Provider(health_error)),
                Err(shutdown_error) => Err(EngineError::Provider(ProviderError::with_reason(
                    reason,
                    format!("{health_error}; provider cleanup also failed: {shutdown_error}"),
                ))),
            };
        }
        let selector = PolicySelector::new(config.clone());
        Ok(Self {
            config,
            selector,
            provider,
            recovery,
            execution_locks: ExecutionLocks::default(),
        })
    }

    pub fn config(&self) -> &BackendConfig {
        &self.config
    }

    pub fn provider_kind(&self) -> &'static str {
        self.provider.kind()
    }

    pub fn recovery(&self) -> ProviderRecovery {
        self.recovery
    }

    pub fn idempotency_retention_seconds(&self) -> u64 {
        self.config.retention.idempotency_seconds
    }

    pub fn change_retention_seconds(&self) -> u64 {
        self.config.retention.changes_seconds
    }

    pub async fn checkpoint(&self) -> Result<(), EngineError> {
        self.provider.checkpoint().await?;
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<(), EngineError> {
        self.provider.shutdown().await?;
        Ok(())
    }
}

fn validate_provider_capabilities(
    config: &BackendConfig,
    capabilities: ProviderCapabilities,
) -> Result<(), EngineError> {
    if !capabilities.change_stream {
        return Err(EngineError::Capability(
            "change streams are required".to_owned(),
        ));
    }
    if !capabilities.retrieval {
        return Err(EngineError::Capability(
            "entity retrieval is required".to_owned(),
        ));
    }
    if !capabilities.authority {
        return Err(EngineError::Capability(
            "CRUD mutations require an authority provider".to_owned(),
        ));
    }
    for (entity_type, policy) in &config.entity_types {
        for behavior in policy
            .rules
            .iter()
            .map(|rule| &rule.behavior)
            .chain(std::iter::once(&policy.fallback))
        {
            let linearizable =
                behavior
                    .consistency
                    .acquire
                    .requirements
                    .iter()
                    .any(|requirement| {
                        matches!(requirement, crate::AcquireRequirement::Linearizable { .. })
                    });
            if !behavior
                .consistency
                .acquire
                .allow_sources
                .contains(&ConsistencySource::Authority)
            {
                return Err(EngineError::Capability(format!(
                    "entity type {entity_type:?} must allow authority reads for mutations"
                )));
            }
            let mut sources = behavior
                .consistency
                .acquire
                .allow_sources
                .iter()
                .copied()
                .collect::<BTreeSet<_>>();
            if linearizable {
                sources.retain(|source| *source == ConsistencySource::Authority);
            }
            if !(capabilities.authority && sources.contains(&ConsistencySource::Authority)
                || capabilities.replica && sources.contains(&ConsistencySource::Replica))
            {
                return Err(EngineError::Capability(format!(
                    "entity type {entity_type:?} has no acquisition source supported by the provider"
                )));
            }
            if behavior
                .consistency
                .acquire
                .requirements
                .iter()
                .any(|requirement| {
                    matches!(requirement, crate::AcquireRequirement::CausalAfter { .. })
                })
                && !capabilities.causal_reads
            {
                return Err(EngineError::Capability(format!(
                    "entity type {entity_type:?} requires causal reads"
                )));
            }
            if linearizable && !capabilities.linearizable_reads {
                return Err(EngineError::Capability(format!(
                    "entity type {entity_type:?} requires linearizable reads"
                )));
            }
            for session in &behavior.consistency.sessions {
                if session
                    .guarantees
                    .contains(&crate::SessionGuarantee::MonotonicReads)
                    && !capabilities.monotonic_reads
                {
                    return Err(EngineError::Capability(format!(
                        "entity type {entity_type:?} requires monotonic reads"
                    )));
                }
                if session
                    .guarantees
                    .contains(&crate::SessionGuarantee::ReadYourWrites)
                    && !capabilities.read_your_writes
                {
                    return Err(EngineError::Capability(format!(
                        "entity type {entity_type:?} requires read-your-writes"
                    )));
                }
            }
            if matches!(behavior.idempotency, crate::IdempotencyPolicy::Keyed { .. })
                && !capabilities.idempotency
            {
                return Err(EngineError::Capability(format!(
                    "entity type {entity_type:?} requires keyed idempotency"
                )));
            }
            if matches!(behavior.publication, PublicationPolicy::Batch { .. })
                && !capabilities.work_units
            {
                return Err(EngineError::Capability(format!(
                    "entity type {entity_type:?} requires durable work units"
                )));
            }
        }
    }
    Ok(())
}

#[async_trait]
impl BackendService for BackendEngine {
    async fn create(&self, params: CreateEntityParams) -> Result<MutationResult, BackendError> {
        let deadline = RequestDeadline::from_meta(&params.meta)?;
        deadline.check_now()?;
        let selection = self.select(&params.data.entity_type, &params.meta)?;
        let _execution_guards = self.execution_locks.acquire(&selection, true).await?;
        deadline.check_now()?;
        let work_unit = selected_work_unit(&selection, deadline)?;
        let consistency =
            read_consistency(std::slice::from_ref(&selection), deadline.unix_ms(), true)?;
        let idempotency = self
            .prepare_idempotency(
                &selection,
                work_unit.as_ref(),
                consistency.clone(),
                "create",
                &params.data,
            )
            .await?;
        if let Some(result) = replayed(&idempotency)? {
            return Ok(result);
        }
        self.config
            .validate_entity_value(&params.data.entity_type, &params.data.value)
            .map_err(invalid_request)?;

        let entity_ref = EntityRef {
            entity_type: params.data.entity_type,
            id: params.data.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        };
        let key = entity_key(&selection, &entity_ref)?;
        if let Some(snapshot) = read_selected(
            self.provider.as_ref(),
            work_unit.as_ref(),
            &key,
            consistency,
        )
        .await?
        .0
        {
            return Err(BackendError::version_conflict(snapshot.head_versions));
        }

        let version = Uuid::new_v4().to_string();
        let stored = active_stored_version(
            version.clone(),
            params.data.value.clone(),
            initial_crdt_fields(&selection.conflict, &params.data.value)?,
        )?;
        let commit = EntityCommit {
            key,
            expected_heads: Vec::new(),
            new_versions: vec![stored],
            head_versions: vec![version.clone()],
            change_kind: StoredChangeKind::Created,
            causal_token: version.clone(),
            event_meta_json: event_meta_json(&selection)?,
            write_session_keys: write_session_keys(&selection)?,
            ordering_key_json: ordering_key_json(&selection)?,
            recorded_at_unix_ms: unix_time_ms()?,
            deadline_unix_ms: deadline.unix_ms(),
        };
        let mut result = mutation_result(entity_ref.clone(), version.clone(), params.data.value);
        result.meta = consistency_meta(&selection, Some(version));
        if work_unit.is_none()
            && let Some(idempotency) = idempotency
        {
            return self.commit_idempotent(commit, idempotency, result).await;
        }
        let idempotency = idempotency
            .map(|prepared| self.idempotency_record(prepared, &result))
            .transpose()?;
        if let Some(snapshot) = self
            .commit_selected(&selection, work_unit, commit, idempotency)
            .await?
        {
            return active_mutation_result(entity_ref, &snapshot);
        }
        Ok(result)
    }

    async fn read(&self, params: ReadEntityParams) -> Result<ReadEntityResult, BackendError> {
        let deadline = RequestDeadline::from_meta(&params.meta)?;
        deadline.check_now()?;
        let selection = self.select(&params.data.entity_ref.entity_type, &params.meta)?;
        let _execution_guards = self.execution_locks.acquire(&selection, false).await?;
        deadline.check_now()?;
        let work_unit = selected_work_unit(&selection, deadline)?;
        let key = entity_key(&selection, &params.data.entity_ref)?;
        let consistency =
            read_consistency(std::slice::from_ref(&selection), deadline.unix_ms(), false)?;
        let (snapshot, observation) = read_selected(
            self.provider.as_ref(),
            work_unit.as_ref(),
            &key,
            consistency,
        )
        .await?;
        let snapshot = snapshot.ok_or_else(not_found)?;
        deadline.check_now()?;
        let variants = head_entities(&params.data.entity_ref, &snapshot)?;
        let state = read_state(&variants);
        Ok(RpcResult {
            meta: consistency_meta(&selection, observation.causal_token),
            data: ReadEntityResultData { state, variants },
        })
    }

    async fn retrieve(
        &self,
        params: RetrieveEntitiesParams,
    ) -> Result<RetrieveEntitiesResult, BackendError> {
        let deadline = RequestDeadline::from_meta(&params.meta)?;
        deadline.check_now()?;
        if params.data.limit == 0 || params.data.limit > 100 {
            return Err(invalid_request("retrieval limit must be between 1 and 100"));
        }
        if let Some(types) = &params.data.types
            && (types.is_empty()
                || types
                    .iter()
                    .any(|name| !self.config.entity_types.contains_key(name)))
        {
            return Err(invalid_request(
                "retrieval types must be a non-empty list of configured entity types",
            ));
        }
        let mut selected_types = params
            .data
            .types
            .clone()
            .unwrap_or_else(|| self.config.entity_types.keys().cloned().collect());
        selected_types.sort();
        selected_types.dedup();
        let selections = selected_types
            .iter()
            .map(|entity_type| self.select(entity_type, &params.meta))
            .collect::<Result<Vec<_>, _>>()?;
        let _consistency_guards = self
            .execution_locks
            .acquire_many(&selections, false)
            .await?;
        deadline.check_now()?;
        let consistency = read_consistency(&selections, deadline.unix_ms(), false)?;
        let mut result_meta = Meta::new();
        let work_unit = selected_retrieval_work_unit(&selections, deadline)?;
        let meta = serde_json::to_value(&params.meta).map_err(invalid_request)?;
        let scope = self.selector.select_scope(&meta).map_err(invalid_request)?;
        let query = parse_query(
            serde_json::to_string(&scope).map_err(invalid_request)?,
            selected_types,
            &params.data.query,
            params.data.limit,
        )?;
        let page = match work_unit {
            Some(work_unit) => match self
                .provider
                .retrieve_entities_in_work_unit(&work_unit.work_unit, query, consistency)
                .await
                .map_err(provider_backend_error)?
            {
                WorkUnitRetrieveOutcome::Open(read) => consistent_value(read)?,
                WorkUnitRetrieveOutcome::Closing => return Err(closed_work_unit()),
                WorkUnitRetrieveOutcome::PolicyMismatch => {
                    return Err(work_unit_policy_mismatch());
                }
                WorkUnitRetrieveOutcome::Committed => return Err(closed_work_unit()),
                WorkUnitRetrieveOutcome::Expired => return Err(expired_work_unit()),
            },
            None => self
                .provider
                .retrieve_entities(query, consistency)
                .await
                .map_err(provider_backend_error)
                .and_then(consistent_value)?,
        };
        for selection in &selections {
            result_meta.extend(consistency_meta(selection, page.1.causal_token.clone()));
        }
        let page = page.0;
        deadline.check_now()?;
        if let Some(cursor) = &page.next_cursor {
            result_meta.insert(
                "next_cursor".to_owned(),
                Value::String(encode_cursor(cursor)?),
            );
        }
        let hits = page
            .entities
            .into_iter()
            .map(|entity| {
                let entity_ref = EntityRef {
                    entity_type: entity.key.entity_type,
                    id: entity.key.entity_id,
                };
                Ok(RetrievalHit {
                    score: entity.score,
                    variants: head_entities(&entity_ref, &entity.snapshot)?,
                })
            })
            .collect::<Result<_, BackendError>>()?;
        Ok(RpcResult {
            meta: result_meta,
            data: RetrieveEntitiesResultData { hits },
        })
    }

    async fn update(&self, params: UpdateEntityParams) -> Result<MutationResult, BackendError> {
        let deadline = RequestDeadline::from_meta(&params.meta)?;
        deadline.check_now()?;
        let selection = self.select(&params.data.entity_ref.entity_type, &params.meta)?;
        let _execution_guards = self.execution_locks.acquire(&selection, true).await?;
        deadline.check_now()?;
        let work_unit = selected_work_unit(&selection, deadline)?;
        let consistency =
            read_consistency(std::slice::from_ref(&selection), deadline.unix_ms(), true)?;
        let idempotency = self
            .prepare_idempotency(
                &selection,
                work_unit.as_ref(),
                consistency.clone(),
                "update",
                &params.data,
            )
            .await?;
        if let Some(result) = replayed(&idempotency)? {
            return Ok(result);
        }
        self.config
            .validate_entity_value(&params.data.entity_ref.entity_type, &params.data.value)
            .map_err(invalid_request)?;
        let key = entity_key(&selection, &params.data.entity_ref)?;
        let snapshot = read_selected(
            self.provider.as_ref(),
            work_unit.as_ref(),
            &key,
            consistency,
        )
        .await?
        .0
        .ok_or_else(not_found)?;
        let bases = selected_bases(&selection.conflict, &snapshot)?;
        reject_unless_exact_heads(&selection.conflict, &snapshot, &bases)?;
        let expected_heads = snapshot.head_versions.clone();
        let concurrent = concurrent_heads(&snapshot, &bases)?;

        if selection.conflict.strategy == ConflictStrategy::Reject && !concurrent.is_empty() {
            return Err(BackendError::version_conflict(snapshot.head_versions));
        }

        let proposed = prepare_candidate(&selection.conflict, &bases, params.data.value.clone())
            .map_err(|error| with_current_versions(error, &snapshot.head_versions))?;
        let mut active_candidates = vec![proposed];
        let mut preserved_deleted = Vec::new();
        for version in concurrent {
            match version.state {
                StoredVersionState::Active => {
                    active_candidates.push(stored_candidate(version)?);
                }
                StoredVersionState::Deleted => preserved_deleted.push(version.version.clone()),
            }
        }
        if !preserved_deleted.is_empty() && selection.conflict.otherwise == ConflictFallback::Reject
        {
            return Err(BackendError::version_conflict(snapshot.head_versions));
        }

        let resolved = resolve_prepared_conflict(&selection.conflict, &active_candidates)
            .map_err(conflict_backend_error)
            .map_err(|error| with_current_versions(error, &snapshot.head_versions))?;
        let mut new_versions = Vec::new();
        let mut head_versions = preserved_deleted;
        let mut accepted = None;
        for candidate in resolved.variants {
            match candidate.source_version {
                Some(version) => head_versions.push(version),
                None => {
                    let version = Uuid::new_v4().to_string();
                    let stored = active_stored_version(
                        version.clone(),
                        candidate.value.clone(),
                        candidate.crdt_fields,
                    )?;
                    if accepted.is_none() {
                        accepted = Some((version.clone(), candidate.value));
                    }
                    head_versions.push(version);
                    new_versions.push(stored);
                }
            }
        }
        let (accepted_version, accepted_value) = accepted.ok_or_else(|| {
            BackendError::new(
                BackendErrorReason::Overloaded,
                "conflict resolution did not produce a candidate version",
            )
        })?;
        let kind = mutation_change_kind(&snapshot, &head_versions, false);
        let mut result = mutation_result(
            params.data.entity_ref.clone(),
            accepted_version.clone(),
            accepted_value,
        );
        result.meta = consistency_meta(&selection, Some(accepted_version.clone()));
        let commit = EntityCommit {
            key,
            expected_heads,
            new_versions,
            head_versions,
            change_kind: kind,
            causal_token: accepted_version,
            event_meta_json: event_meta_json(&selection)?,
            write_session_keys: write_session_keys(&selection)?,
            ordering_key_json: ordering_key_json(&selection)?,
            recorded_at_unix_ms: unix_time_ms()?,
            deadline_unix_ms: deadline.unix_ms(),
        };
        if work_unit.is_none()
            && let Some(idempotency) = idempotency
        {
            return self.commit_idempotent(commit, idempotency, result).await;
        }
        let idempotency = idempotency
            .map(|prepared| self.idempotency_record(prepared, &result))
            .transpose()?;
        if let Some(snapshot) = self
            .commit_selected(&selection, work_unit, commit, idempotency)
            .await?
        {
            return active_mutation_result(params.data.entity_ref, &snapshot);
        }

        Ok(result)
    }

    async fn delete(&self, params: DeleteEntityParams) -> Result<MutationResult, BackendError> {
        let deadline = RequestDeadline::from_meta(&params.meta)?;
        deadline.check_now()?;
        let selection = self.select(&params.data.entity_ref.entity_type, &params.meta)?;
        let _execution_guards = self.execution_locks.acquire(&selection, true).await?;
        deadline.check_now()?;
        let work_unit = selected_work_unit(&selection, deadline)?;
        let consistency =
            read_consistency(std::slice::from_ref(&selection), deadline.unix_ms(), true)?;
        let idempotency = self
            .prepare_idempotency(
                &selection,
                work_unit.as_ref(),
                consistency.clone(),
                "delete",
                &params.data,
            )
            .await?;
        if let Some(result) = replayed(&idempotency)? {
            return Ok(result);
        }
        let key = entity_key(&selection, &params.data.entity_ref)?;
        let snapshot = read_selected(
            self.provider.as_ref(),
            work_unit.as_ref(),
            &key,
            consistency,
        )
        .await?
        .0
        .ok_or_else(not_found)?;
        let bases = selected_bases(&selection.conflict, &snapshot)?;
        reject_unless_exact_heads(&selection.conflict, &snapshot, &bases)?;
        let concurrent = concurrent_heads(&snapshot, &bases)?;
        if !concurrent.is_empty()
            && (selection.conflict.strategy == ConflictStrategy::Reject
                || selection.conflict.otherwise == ConflictFallback::Reject)
        {
            return Err(BackendError::version_conflict(snapshot.head_versions));
        }

        let version = Uuid::new_v4().to_string();
        let mut head_versions = concurrent
            .into_iter()
            .map(|version| version.version.clone())
            .collect::<Vec<_>>();
        head_versions.push(version.clone());
        let deleted = StoredEntityVersion {
            version: version.clone(),
            state: StoredVersionState::Deleted,
            value_json: None,
            crdt_fields: Vec::new(),
        };
        let kind = mutation_change_kind(&snapshot, &head_versions, true);
        let result = RpcResult {
            meta: consistency_meta(&selection, Some(version.clone())),
            data: MutationData {
                entity: EntityVersion::Deleted {
                    entity_ref: params.data.entity_ref.clone(),
                    version: version.clone(),
                },
            },
        };
        let commit = EntityCommit {
            key,
            expected_heads: snapshot.head_versions,
            new_versions: vec![deleted],
            head_versions,
            change_kind: kind,
            causal_token: version,
            event_meta_json: event_meta_json(&selection)?,
            write_session_keys: write_session_keys(&selection)?,
            ordering_key_json: ordering_key_json(&selection)?,
            recorded_at_unix_ms: unix_time_ms()?,
            deadline_unix_ms: deadline.unix_ms(),
        };
        if work_unit.is_none()
            && let Some(idempotency) = idempotency
        {
            return self.commit_idempotent(commit, idempotency, result).await;
        }
        let idempotency = idempotency
            .map(|prepared| self.idempotency_record(prepared, &result))
            .transpose()?;
        let _ = self
            .commit_selected(&selection, work_unit, commit, idempotency)
            .await?;
        Ok(result)
    }

    async fn subscribe(
        &self,
        params: SubscribeChangesParams,
    ) -> Result<ChangeSubscription, BackendError> {
        let deadline = RequestDeadline::from_meta(&params.meta)?;
        deadline.check_now()?;
        let meta = serde_json::to_value(&params.meta).map_err(invalid_request)?;
        let scope = self.selector.select_scope(&meta).map_err(invalid_request)?;
        let scope_json = serde_json::to_string(&scope).map_err(invalid_request)?;
        let filter = params.data.filter.unwrap_or_default();
        let provider = Arc::clone(&self.provider);
        let change_retention_seconds = self.config.retention.changes_seconds;
        let probe = provider
            .read_changes(ChangeQuery {
                scope_json: scope_json.clone(),
                entity_types: filter.types.clone(),
                entity_ids: filter.ids.clone(),
                after_cursor: 0,
                limit: 1,
                retained_after_unix_ms: retained_after(change_retention_seconds)?,
            })
            .await
            .map_err(provider_backend_error)?;
        deadline.check_now()?;
        let cursor = match params.data.after_cursor {
            Some(cursor) => parse_change_cursor(&cursor)?,
            None => probe.current_cursor,
        };
        validate_change_cursor(cursor, &probe)?;
        let stream = async_stream::try_stream! {
            let mut cursor = cursor;
            loop {
                let page = provider
                    .read_changes(ChangeQuery {
                        scope_json: scope_json.clone(),
                        entity_types: filter.types.clone(),
                        entity_ids: filter.ids.clone(),
                        after_cursor: cursor,
                        limit: 256,
                        retained_after_unix_ms: retained_after(change_retention_seconds)?,
                    })
                    .await
                    .map_err(provider_backend_error)?;
                validate_change_cursor(cursor, &page)?;
                if page.changes.is_empty() {
                    cursor = page.current_cursor;
                    provider
                        .wait_for_changes(&scope_json, cursor)
                        .await
                        .map_err(provider_backend_error)?;
                    continue;
                }
                for change in page.changes {
                    cursor = change.cursor;
                    let event_meta: Meta = serde_json::from_str(&change.event_meta_json)
                        .map_err(|_| provider_corruption("stored change metadata is invalid"))?;
                    yield PublishedChange {
                        meta: event_meta,
                        change: ChangeRecord {
                        cursor: cursor.to_string(),
                        entity_ref: EntityRef {
                            entity_type: change.entity_type,
                            id: change.entity_id,
                        },
                        kind: match change.kind {
                            StoredChangeKind::Conflicted => ChangeKind::Conflicted,
                            StoredChangeKind::Created => ChangeKind::Created,
                            StoredChangeKind::Deleted => ChangeKind::Deleted,
                            StoredChangeKind::Resolved => ChangeKind::Resolved,
                            StoredChangeKind::Updated => ChangeKind::Updated,
                        },
                        head_versions: change.head_versions,
                        },
                    };
                }
            }
        };
        Ok(ChangeSubscription {
            cursor: cursor.to_string(),
            stream: Box::pin(stream),
        })
    }
}

fn parse_change_cursor(cursor: &str) -> Result<u64, BackendError> {
    cursor.parse().map_err(|_| {
        BackendError::new(
            BackendErrorReason::InvalidRequest,
            "change cursor must be an unsigned decimal integer",
        )
    })
}

fn retained_after(retention_seconds: u64) -> Result<u64, BackendError> {
    let retention_ms = retention_seconds
        .checked_mul(1_000)
        .ok_or_else(|| invalid_request("change retention overflows"))?;
    Ok(unix_time_ms()?.saturating_sub(retention_ms))
}

fn validate_change_cursor(
    cursor: u64,
    page: &patchouli_provider::ChangePage,
) -> Result<(), BackendError> {
    if cursor > page.current_cursor
        || page
            .oldest_cursor
            .is_some_and(|oldest| cursor.saturating_add(1) < oldest)
    {
        return Err(BackendError::new(
            BackendErrorReason::CursorExpired,
            "change cursor is outside the retained log",
        ));
    }
    Ok(())
}

impl BackendEngine {
    fn select(&self, entity_type: &str, meta: &Meta) -> Result<PolicySelection, BackendError> {
        let meta = serde_json::to_value(meta).map_err(invalid_request)?;
        self.selector
            .select(entity_type, &meta)
            .map_err(invalid_request)
    }

    async fn prepare_idempotency<T: Serialize>(
        &self,
        selection: &PolicySelection,
        work_unit: Option<&SelectedWorkUnit>,
        consistency: ReadConsistency,
        operation: &str,
        data: &T,
    ) -> Result<Option<PreparedIdempotency>, BackendError> {
        let key = match (&selection.behavior.idempotency, &selection.idempotency_key) {
            (crate::IdempotencyPolicy::Disabled, _) => return Ok(None),
            (crate::IdempotencyPolicy::Keyed { .. }, Some(key)) => key,
            (crate::IdempotencyPolicy::Keyed { .. }, None) => {
                return Err(invalid_request(
                    "configured keyed idempotency metadata is required for mutations",
                ));
            }
        };
        let identity_json = serde_json::to_string(key).map_err(invalid_request)?;
        let request_json = serde_json::to_string(&IdempotencyRequest { operation, data })
            .map_err(invalid_request)?;
        let now = unix_time_ms()?;
        let outcome = match work_unit {
            Some(work_unit) => {
                self.provider
                    .read_idempotency_in_work_unit(
                        &work_unit.work_unit,
                        consistency,
                        &identity_json,
                        &request_json,
                        now,
                        !work_unit.close,
                    )
                    .await
            }
            None => {
                self.provider
                    .read_idempotency(
                        &serde_json::to_string(&selection.scope).map_err(invalid_request)?,
                        consistency,
                        &identity_json,
                        &request_json,
                        now,
                    )
                    .await
            }
        }
        .map_err(provider_backend_error)?;
        let result_json = match outcome {
            IdempotencyReadOutcome::Missing => None,
            IdempotencyReadOutcome::Replayed { result_json } => Some(result_json),
            IdempotencyReadOutcome::Conflict => return Err(idempotency_conflict()),
            IdempotencyReadOutcome::Unavailable => {
                return Err(BackendError::new(
                    BackendErrorReason::Overloaded,
                    "the requested consistency frontier is not currently available",
                ));
            }
        };
        Ok(Some(PreparedIdempotency {
            identity_json,
            request_json,
            result_json,
        }))
    }

    async fn commit_idempotent(
        &self,
        commit: EntityCommit,
        prepared: PreparedIdempotency,
        result: MutationResult,
    ) -> Result<MutationResult, BackendError> {
        let now = unix_time_ms()?;
        let outcome = self
            .provider
            .commit_entity_idempotent(
                commit,
                self.idempotency_record_at(prepared, &result, now)?,
                now,
            )
            .await
            .map_err(provider_backend_error)?;
        match outcome {
            IdempotentCommitOutcome::Committed => Ok(result),
            IdempotentCommitOutcome::EntityConflict { current_heads } => {
                Err(BackendError::version_conflict(current_heads))
            }
            IdempotentCommitOutcome::Replayed { result_json } => serde_json::from_str(&result_json)
                .map_err(|_| provider_corruption("stored idempotency result is invalid")),
            IdempotentCommitOutcome::IdempotencyConflict => Err(idempotency_conflict()),
        }
    }

    fn idempotency_record(
        &self,
        prepared: PreparedIdempotency,
        result: &MutationResult,
    ) -> Result<IdempotencyRecord, BackendError> {
        self.idempotency_record_at(prepared, result, unix_time_ms()?)
    }

    fn idempotency_record_at(
        &self,
        prepared: PreparedIdempotency,
        result: &MutationResult,
        now: u64,
    ) -> Result<IdempotencyRecord, BackendError> {
        let retention_ms = self
            .config
            .retention
            .idempotency_seconds
            .checked_mul(1_000)
            .ok_or_else(|| invalid_request("idempotency retention overflows"))?;
        Ok(IdempotencyRecord {
            identity_json: prepared.identity_json,
            request_json: prepared.request_json,
            result_json: serde_json::to_string(result).map_err(invalid_request)?,
            expires_at_unix_ms: now
                .checked_add(retention_ms)
                .ok_or_else(|| invalid_request("idempotency expiry overflows Unix time"))?,
        })
    }
}

#[derive(Serialize)]
struct IdempotencyRequest<'a, T> {
    operation: &'a str,
    data: &'a T,
}

struct PreparedIdempotency {
    identity_json: String,
    request_json: String,
    result_json: Option<String>,
}

fn replayed<T: DeserializeOwned>(
    prepared: &Option<PreparedIdempotency>,
) -> Result<Option<T>, BackendError> {
    prepared
        .as_ref()
        .and_then(|prepared| prepared.result_json.as_deref())
        .map(|result| {
            serde_json::from_str(result)
                .map_err(|_| provider_corruption("stored idempotency result is invalid"))
        })
        .transpose()
}

fn idempotency_conflict() -> BackendError {
    BackendError::new(
        BackendErrorReason::IdempotencyConflict,
        "idempotency identity was already used for a different mutation",
    )
}

fn write_session_keys(selection: &PolicySelection) -> Result<Vec<String>, BackendError> {
    selection
        .consistency
        .sessions
        .iter()
        .filter(|session| {
            session
                .guarantees
                .contains(&crate::SessionGuarantee::ReadYourWrites)
        })
        .map(|session| serde_json::to_string(&session.key).map_err(invalid_request))
        .collect()
}

fn ordering_key_json(selection: &PolicySelection) -> Result<Option<String>, BackendError> {
    selection
        .consistency
        .commit_ordering_key
        .as_ref()
        .map(|key| serde_json::to_string(key).map_err(invalid_request))
        .transpose()
}

fn read_consistency(
    selections: &[PolicySelection],
    deadline_unix_ms: Option<u64>,
    authority_only: bool,
) -> Result<ReadConsistency, BackendError> {
    let mut allowed_sources = selections
        .first()
        .map(|selection| selection.consistency.allowed_sources.clone())
        .unwrap_or_default();
    let mut minimum_tokens = BTreeSet::new();
    let mut sessions = BTreeMap::<String, (bool, bool)>::new();
    let mut linearization_keys = BTreeSet::new();

    for selection in selections {
        allowed_sources = allowed_sources
            .intersection(&selection.consistency.allowed_sources)
            .copied()
            .collect();
        for causal in &selection.consistency.causal {
            if let Some(token) = &causal.minimum {
                minimum_tokens.insert(
                    token
                        .as_str()
                        .ok_or_else(|| invalid_request("causal tokens must be strings"))?
                        .to_owned(),
                );
            }
        }
        for session in &selection.consistency.sessions {
            let key = serde_json::to_string(&session.key).map_err(invalid_request)?;
            let guarantees = sessions.entry(key).or_default();
            guarantees.0 |= session
                .guarantees
                .contains(&crate::SessionGuarantee::MonotonicReads);
            guarantees.1 |= session
                .guarantees
                .contains(&crate::SessionGuarantee::ReadYourWrites);
        }
        if let Some(key) = &selection.consistency.linearization_key {
            linearization_keys.insert(serde_json::to_string(key).map_err(invalid_request)?);
        }
    }

    if authority_only {
        allowed_sources.retain(|source| *source == ConsistencySource::Authority);
    }

    if allowed_sources.is_empty() {
        return Err(BackendError::new(
            BackendErrorReason::UnsupportedCapability,
            "the selected entity types have no common consistency source",
        ));
    }
    Ok(ReadConsistency {
        allowed_sources: allowed_sources.into_iter().collect(),
        minimum_tokens: minimum_tokens.into_iter().collect(),
        sessions: sessions
            .into_iter()
            .map(
                |(key_json, (monotonic_reads, read_your_writes))| SessionConsistency {
                    key_json,
                    monotonic_reads,
                    read_your_writes,
                },
            )
            .collect(),
        linearization_keys: linearization_keys.into_iter().collect(),
        deadline_unix_ms,
    })
}

fn consistent_value<T>(outcome: ConsistentRead<T>) -> Result<(T, ReadObservation), BackendError> {
    match outcome {
        ConsistentRead::Read { value, observation } => Ok((value, observation)),
        ConsistentRead::Unavailable => Err(BackendError::new(
            BackendErrorReason::Overloaded,
            "the requested consistency frontier is not currently available",
        )),
    }
}

fn event_meta_json(selection: &PolicySelection) -> Result<String, BackendError> {
    serde_json::to_string(&selection.fields).map_err(invalid_request)
}

fn consistency_meta(selection: &PolicySelection, causal_token: Option<String>) -> Meta {
    let mut meta = Meta::new();
    if let Some(token) = causal_token {
        for causal in &selection.consistency.causal {
            meta.insert(causal.field.clone(), Value::String(token.clone()));
        }
    }
    meta
}

struct SelectedWorkUnit {
    work_unit: WorkUnit,
    close: bool,
}

#[derive(Serialize)]
struct WorkUnitPolicy<'a> {
    snapshot_key: &'a Option<crate::ControlKey>,
    publication: &'a PublicationPolicy,
    linearization_key: &'a Option<crate::ControlKey>,
    commit_ordering_key: &'a Option<crate::ControlKey>,
}

fn selected_work_unit(
    selection: &PolicySelection,
    deadline: RequestDeadline,
) -> Result<Option<SelectedWorkUnit>, BackendError> {
    let PublicationPolicy::Batch {
        close_when,
        staging_ttl_ms,
        ..
    } = &selection.behavior.publication
    else {
        return Ok(None);
    };
    let key = selection
        .publication_key
        .as_ref()
        .ok_or_else(|| provider_corruption("batch publication has no work-unit key"))?;
    let identity_json = serde_json::to_string(key).map_err(invalid_request)?;
    let policy_json = serde_json::to_string(&WorkUnitPolicy {
        snapshot_key: &selection.consistency.snapshot_key,
        publication: &selection.behavior.publication,
        linearization_key: &selection.consistency.linearization_key,
        commit_ordering_key: &selection.consistency.commit_ordering_key,
    })
    .map_err(invalid_request)?;
    let now = unix_time_ms()?;
    let expires = now
        .checked_add(*staging_ttl_ms)
        .ok_or_else(|| invalid_request("work-unit expiry overflows Unix time"))?;
    let BatchCloseCondition::Marker { field, equals } = close_when;
    let close = selection.fields.get(field) == Some(equals);
    Ok(Some(SelectedWorkUnit {
        work_unit: WorkUnit {
            identity_json,
            scope_json: serde_json::to_string(&selection.scope).map_err(invalid_request)?,
            policy_json,
            expiry_action: WorkUnitExpiryAction::Discard,
            now_unix_ms: now,
            expires_at_unix_ms: expires,
            deadline_unix_ms: deadline.unix_ms(),
        },
        close,
    }))
}

fn selected_retrieval_work_unit(
    selections: &[PolicySelection],
    deadline: RequestDeadline,
) -> Result<Option<SelectedWorkUnit>, BackendError> {
    let mut selected = selections
        .iter()
        .map(|selection| selected_work_unit(selection, deadline));
    let first = selected.next().transpose()?.flatten();
    for next in selected {
        let next = next?;
        match (&first, &next) {
            (None, None) => {}
            (Some(first), Some(next))
                if first.work_unit.identity_json == next.work_unit.identity_json
                    && first.work_unit.scope_json == next.work_unit.scope_json
                    && first.work_unit.policy_json == next.work_unit.policy_json => {}
            _ => {
                return Err(invalid_request(
                    "retrieved entity types must select the same transaction behavior",
                ));
            }
        }
    }
    Ok(first)
}

fn entity_key(
    selection: &PolicySelection,
    entity_ref: &EntityRef,
) -> Result<EntityKey, BackendError> {
    Ok(EntityKey {
        scope_json: serde_json::to_string(&selection.scope).map_err(invalid_request)?,
        entity_type: entity_ref.entity_type.clone(),
        entity_id: entity_ref.id.clone(),
    })
}

fn selected_bases<'a>(
    plan: &ConflictPlan,
    snapshot: &'a EntitySnapshot,
) -> Result<Vec<&'a StoredEntityVersion>, BackendError> {
    let values = plan
        .base_versions
        .as_ref()
        .and_then(Value::as_array)
        .ok_or_else(|| {
            BackendError::new(
                BackendErrorReason::InvalidRequest,
                format!("metadata field {:?} is required", plan.base_versions_field),
            )
        })?;
    if values.is_empty() {
        return Err(BackendError::new(
            BackendErrorReason::InvalidRequest,
            "base_versions must not be empty",
        ));
    }
    let mut names = BTreeSet::new();
    for value in values {
        let Some(version) = value.as_str() else {
            return Err(BackendError::new(
                BackendErrorReason::InvalidRequest,
                "base_versions must contain only strings",
            ));
        };
        if !names.insert(version) {
            return Err(BackendError::new(
                BackendErrorReason::InvalidRequest,
                "base_versions must not contain duplicates",
            ));
        }
    }
    let versions = names
        .into_iter()
        .map(|name| {
            snapshot
                .versions
                .iter()
                .find(|version| version.version == name)
                .ok_or_else(|| BackendError::version_conflict(snapshot.head_versions.clone()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(versions)
}

fn concurrent_heads<'a>(
    snapshot: &'a EntitySnapshot,
    bases: &[&StoredEntityVersion],
) -> Result<Vec<&'a StoredEntityVersion>, BackendError> {
    let bases = bases
        .iter()
        .map(|version| version.version.as_str())
        .collect::<BTreeSet<_>>();
    snapshot
        .head_versions
        .iter()
        .filter(|version| !bases.contains(version.as_str()))
        .map(|version| {
            snapshot
                .versions
                .iter()
                .find(|stored| &stored.version == version)
                .ok_or_else(|| provider_corruption("current head version is missing"))
        })
        .collect()
}

fn reject_unless_exact_heads(
    plan: &ConflictPlan,
    snapshot: &EntitySnapshot,
    bases: &[&StoredEntityVersion],
) -> Result<(), BackendError> {
    if plan.strategy != ConflictStrategy::Reject {
        return Ok(());
    }
    let bases = bases
        .iter()
        .map(|version| version.version.as_str())
        .collect::<BTreeSet<_>>();
    let heads = snapshot
        .head_versions
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if bases != heads {
        return Err(BackendError::version_conflict(
            snapshot.head_versions.clone(),
        ));
    }
    Ok(())
}

fn initial_crdt_fields(
    plan: &ConflictPlan,
    value: &Value,
) -> Result<BTreeMap<String, CrdtDocument>, BackendError> {
    let mut fields = BTreeMap::new();
    for rule in &plan.merge {
        if let Some(field) = value.pointer(&rule.path) {
            fields.insert(
                rule.path.clone(),
                CrdtDocument::from_json(field).map_err(conflict_backend_error)?,
            );
        }
    }
    Ok(fields)
}

fn prepare_candidate(
    plan: &ConflictPlan,
    bases: &[&StoredEntityVersion],
    value: Value,
) -> Result<ConflictCandidate, BackendError> {
    let mut crdt_fields = BTreeMap::new();
    for rule in &plan.merge {
        let Some(proposed_field) = value.pointer(&rule.path) else {
            reject_fallback(plan.otherwise)?;
            continue;
        };
        let mut documents = Vec::new();
        for base in bases {
            if base.state != StoredVersionState::Active {
                reject_fallback(plan.otherwise)?;
                documents.clear();
                break;
            }
            let base_value = stored_value(base)?;
            let Some(base_field) = base_value.pointer(&rule.path) else {
                reject_fallback(plan.otherwise)?;
                documents.clear();
                break;
            };
            if !same_merge_group(rule, base_field, proposed_field) {
                reject_fallback(plan.otherwise)?;
                documents.clear();
                break;
            }
            let Some(field) = base
                .crdt_fields
                .iter()
                .find(|field| field.path == rule.path)
            else {
                reject_fallback(plan.otherwise)?;
                documents.clear();
                break;
            };
            let document = load_crdt_document(field)?;
            if document.json().map_err(conflict_backend_error)? != *base_field {
                return Err(provider_corruption(
                    "stored CRDT field does not match materialized entity JSON",
                ));
            }
            documents.push(document);
        }
        if documents.len() == bases.len() {
            let base = CrdtDocument::merge(&documents).map_err(conflict_backend_error)?;
            crdt_fields.insert(
                rule.path.clone(),
                base.change(proposed_field)
                    .map_err(conflict_backend_error)?,
            );
        } else {
            crdt_fields.insert(
                rule.path.clone(),
                CrdtDocument::from_json(proposed_field).map_err(conflict_backend_error)?,
            );
        }
    }
    Ok(ConflictCandidate {
        value,
        crdt_fields,
        source_version: None,
    })
}

fn stored_candidate(version: &StoredEntityVersion) -> Result<ConflictCandidate, BackendError> {
    let value = stored_value(version)?;
    let crdt_fields = version
        .crdt_fields
        .iter()
        .map(|field| {
            let document = load_crdt_document(field)?;
            if document.json().map_err(conflict_backend_error)?
                != *value
                    .pointer(&field.path)
                    .ok_or_else(|| provider_corruption("stored CRDT field path is absent"))?
            {
                return Err(provider_corruption(
                    "stored CRDT field does not match materialized entity JSON",
                ));
            }
            Ok((field.path.clone(), document))
        })
        .collect::<Result<_, BackendError>>()?;
    Ok(ConflictCandidate {
        value,
        crdt_fields,
        source_version: Some(version.version.clone()),
    })
}

fn same_merge_group(rule: &ConflictMergeRule, left: &Value, right: &Value) -> bool {
    rule.group_by
        .iter()
        .all(|pointer| left.pointer(pointer) == right.pointer(pointer))
}

fn load_crdt_document(field: &StoredCrdtField) -> Result<CrdtDocument, BackendError> {
    let changes = field
        .changes
        .iter()
        .map(|change| CrdtChange {
            hash: change.hash.clone(),
            parents: change.parents.clone(),
            bytes: change.bytes.clone(),
        })
        .collect::<Vec<_>>();
    CrdtDocument::from_changes(&changes, &field.heads).map_err(conflict_backend_error)
}

fn active_stored_version(
    version: String,
    value: Value,
    crdt_fields: BTreeMap<String, CrdtDocument>,
) -> Result<StoredEntityVersion, BackendError> {
    Ok(StoredEntityVersion {
        version,
        state: StoredVersionState::Active,
        value_json: Some(serde_json::to_string(&value).map_err(invalid_request)?),
        crdt_fields: crdt_fields
            .into_iter()
            .map(|(path, document)| stored_crdt_field(path, document))
            .collect::<Result<_, _>>()?,
    })
}

fn stored_crdt_field(
    path: String,
    document: CrdtDocument,
) -> Result<StoredCrdtField, BackendError> {
    Ok(StoredCrdtField {
        path,
        heads: document.heads().map_err(conflict_backend_error)?,
        changes: document
            .changes()
            .map_err(conflict_backend_error)?
            .into_iter()
            .map(|change| StoredCrdtChange {
                hash: change.hash,
                parents: change.parents,
                bytes: change.bytes,
            })
            .collect(),
    })
}

fn head_entities(
    entity_ref: &EntityRef,
    snapshot: &EntitySnapshot,
) -> Result<Vec<EntityVersion>, BackendError> {
    snapshot
        .head_versions
        .iter()
        .map(|version| {
            let stored = snapshot
                .versions
                .iter()
                .find(|stored| &stored.version == version)
                .ok_or_else(|| provider_corruption("current head version is missing"))?;
            stored_entity(entity_ref, stored)
        })
        .collect()
}

fn stored_entity(
    entity_ref: &EntityRef,
    stored: &StoredEntityVersion,
) -> Result<EntityVersion, BackendError> {
    match stored.state {
        StoredVersionState::Active => Ok(EntityVersion::Active {
            entity_ref: entity_ref.clone(),
            version: stored.version.clone(),
            value: stored_value(stored)?,
        }),
        StoredVersionState::Deleted => Ok(EntityVersion::Deleted {
            entity_ref: entity_ref.clone(),
            version: stored.version.clone(),
        }),
    }
}

fn stored_value(stored: &StoredEntityVersion) -> Result<Value, BackendError> {
    let value = stored
        .value_json
        .as_ref()
        .ok_or_else(|| provider_corruption("active version has no JSON value"))?;
    serde_json::from_str(value).map_err(|_| provider_corruption("stored entity JSON is invalid"))
}

fn read_state(variants: &[EntityVersion]) -> ReadState {
    match variants {
        [EntityVersion::Active { .. }] => ReadState::Active,
        [EntityVersion::Deleted { .. }] => ReadState::Deleted,
        _ => ReadState::Conflicted,
    }
}

fn mutation_change_kind(
    snapshot: &EntitySnapshot,
    new_heads: &[String],
    deleted: bool,
) -> StoredChangeKind {
    if new_heads.len() > 1 {
        StoredChangeKind::Conflicted
    } else if snapshot.head_versions.len() > 1 {
        StoredChangeKind::Resolved
    } else if deleted {
        StoredChangeKind::Deleted
    } else {
        StoredChangeKind::Updated
    }
}

fn mutation_result(entity_ref: EntityRef, version: String, value: Value) -> MutationResult {
    RpcResult {
        meta: Meta::new(),
        data: MutationData {
            entity: EntityVersion::Active {
                entity_ref,
                version,
                value,
            },
        },
    }
}

fn active_mutation_result(
    entity_ref: EntityRef,
    snapshot: &EntitySnapshot,
) -> Result<MutationResult, BackendError> {
    let stored = snapshot
        .head_versions
        .iter()
        .map(|version| snapshot_version(snapshot, version))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .find(|version| version.state == StoredVersionState::Active)
        .ok_or_else(|| {
            provider_corruption("successful active mutation published no active entity head")
        })?;
    Ok(mutation_result(
        entity_ref,
        stored.version.clone(),
        stored_value(stored)?,
    ))
}

async fn read_selected(
    provider: &dyn Provider,
    work_unit: Option<&SelectedWorkUnit>,
    key: &EntityKey,
    consistency: ReadConsistency,
) -> Result<(Option<EntitySnapshot>, ReadObservation), BackendError> {
    let Some(work_unit) = work_unit else {
        return provider
            .read_entity(key, consistency)
            .await
            .map_err(provider_backend_error)
            .and_then(consistent_value);
    };
    match provider
        .read_entity_in_work_unit(&work_unit.work_unit, key, consistency)
        .await
        .map_err(provider_backend_error)?
    {
        WorkUnitReadOutcome::Open(read) => consistent_value(read),
        WorkUnitReadOutcome::Closing => Err(closed_work_unit()),
        WorkUnitReadOutcome::PolicyMismatch => Err(work_unit_policy_mismatch()),
        WorkUnitReadOutcome::Committed => Err(closed_work_unit()),
        WorkUnitReadOutcome::Expired => Err(expired_work_unit()),
    }
}

impl BackendEngine {
    async fn commit_selected(
        &self,
        selection: &PolicySelection,
        work_unit: Option<SelectedWorkUnit>,
        commit: EntityCommit,
        idempotency: Option<IdempotencyRecord>,
    ) -> Result<Option<EntitySnapshot>, BackendError> {
        let post_commit_consistency = read_consistency(
            std::slice::from_ref(selection),
            commit.deadline_unix_ms,
            true,
        )?;
        let Some(work_unit) = work_unit else {
            return match self
                .provider
                .commit_entity(commit)
                .await
                .map_err(provider_backend_error)?
            {
                EntityCommitOutcome::Committed => Ok(None),
                EntityCommitOutcome::Conflict { current_heads } => {
                    Err(BackendError::version_conflict(current_heads))
                }
            };
        };
        let conflict_policy_json =
            serde_json::to_string(&selection.conflict).map_err(invalid_request)?;
        let committed_key = commit.key.clone();
        let outcome = self
            .provider
            .commit_entity_in_work_unit(WorkUnitCommit {
                work_unit: work_unit.work_unit.clone(),
                entity: commit,
                conflict_policy_json,
                idempotency,
                close: work_unit.close,
            })
            .await
            .map_err(provider_backend_error)?;
        let WorkUnitCommitOutcome::PublicationConflict { conflicts } = outcome else {
            return map_work_unit_outcome(outcome).map(|()| None);
        };

        let resolutions = self.resolve_publication_conflicts(&conflicts)?;
        let outcome = self
            .provider
            .publish_work_unit(WorkUnitPublish {
                work_unit: work_unit.work_unit,
                resolutions,
                recorded_at_unix_ms: unix_time_ms()?,
            })
            .await
            .map_err(provider_backend_error)?;
        match outcome {
            WorkUnitCommitOutcome::Published => self
                .provider
                .read_entity(&committed_key, post_commit_consistency)
                .await
                .map_err(provider_backend_error)
                .and_then(consistent_value)
                .map(|(snapshot, _)| snapshot),
            WorkUnitCommitOutcome::PublicationConflict { conflicts } => {
                Err(publication_conflict_error(&conflicts))
            }
            other => map_work_unit_outcome(other).map(|()| None),
        }
    }

    fn resolve_publication_conflicts(
        &self,
        conflicts: &[WorkUnitConflict],
    ) -> Result<Vec<WorkUnitResolution>, BackendError> {
        let mut resolutions = Vec::new();
        let mut rejected = Vec::new();
        for conflict in conflicts {
            match self.resolve_publication_conflict(conflict) {
                Ok(resolution) => resolutions.push(resolution),
                Err(error) if error.reason == BackendErrorReason::VersionConflict => {
                    if error.conflicts.is_empty() {
                        rejected.push(EntityVersionConflict {
                            entity_ref: EntityRef {
                                entity_type: conflict.key.entity_type.clone(),
                                id: conflict.key.entity_id.clone(),
                            },
                            current_versions: error.current_versions,
                        });
                    } else {
                        rejected.extend(error.conflicts);
                    }
                }
                Err(error) => return Err(error),
            }
        }
        if rejected.is_empty() {
            Ok(resolutions)
        } else {
            Err(BackendError::entity_conflicts(rejected))
        }
    }

    fn resolve_publication_conflict(
        &self,
        conflict: &WorkUnitConflict,
    ) -> Result<WorkUnitResolution, BackendError> {
        let plan: ConflictPlan = serde_json::from_str(&conflict.conflict_policy_json)
            .map_err(|_| provider_corruption("stored conflict policy is invalid"))?;
        let current_heads = conflict
            .current
            .as_ref()
            .map_or_else(Vec::new, |snapshot| snapshot.head_versions.clone());
        if plan.strategy == ConflictStrategy::Reject {
            return Err(entity_conflict_error(conflict, current_heads));
        }

        let mut heads = BTreeMap::<String, StoredEntityVersion>::new();
        for version in &conflict.staged.head_versions {
            heads.insert(
                version.clone(),
                snapshot_version(&conflict.staged, version)?.clone(),
            );
        }
        if let Some(current) = &conflict.current {
            for version in &current.head_versions {
                heads.insert(version.clone(), snapshot_version(current, version)?.clone());
            }
        }

        let mut candidates = Vec::new();
        let mut deleted = Vec::new();
        for version in heads.values() {
            match version.state {
                StoredVersionState::Active => candidates.push(stored_candidate(version)?),
                StoredVersionState::Deleted => deleted.push(version.version.clone()),
            }
        }
        if !deleted.is_empty() && plan.otherwise == ConflictFallback::Reject {
            return Err(entity_conflict_error(conflict, current_heads));
        }
        let resolved = resolve_prepared_conflict(&plan, &candidates)
            .map_err(conflict_backend_error)
            .map_err(|error| with_current_versions(error, &current_heads))?;
        let mut new_versions = Vec::new();
        let mut head_versions = deleted;
        for candidate in resolved.variants {
            match candidate.source_version {
                Some(version) => head_versions.push(version),
                None => {
                    self.config
                        .validate_entity_value(&conflict.key.entity_type, &candidate.value)
                        .map_err(invalid_request)?;
                    let version = Uuid::new_v4().to_string();
                    head_versions.push(version.clone());
                    new_versions.push(active_stored_version(
                        version,
                        candidate.value,
                        candidate.crdt_fields,
                    )?);
                }
            }
        }
        head_versions.sort();
        head_versions.dedup();
        if head_versions.is_empty() {
            return Err(provider_corruption(
                "publication conflict resolution produced no entity heads",
            ));
        }
        Ok(WorkUnitResolution {
            expected_published_heads: current_heads,
            entity: EntityCommit {
                key: conflict.key.clone(),
                expected_heads: conflict.staged.head_versions.clone(),
                new_versions,
                head_versions,
                change_kind: StoredChangeKind::Updated,
                causal_token: Uuid::new_v4().to_string(),
                event_meta_json: "{}".to_owned(),
                write_session_keys: Vec::new(),
                ordering_key_json: None,
                recorded_at_unix_ms: unix_time_ms()?,
                deadline_unix_ms: None,
            },
        })
    }
}

fn snapshot_version<'a>(
    snapshot: &'a EntitySnapshot,
    version: &str,
) -> Result<&'a StoredEntityVersion, BackendError> {
    snapshot
        .versions
        .iter()
        .find(|stored| stored.version == version)
        .ok_or_else(|| provider_corruption("entity head version is missing"))
}

fn map_work_unit_outcome(outcome: WorkUnitCommitOutcome) -> Result<(), BackendError> {
    match outcome {
        WorkUnitCommitOutcome::Staged | WorkUnitCommitOutcome::Published => Ok(()),
        WorkUnitCommitOutcome::Conflict { current_heads } => {
            Err(BackendError::version_conflict(current_heads))
        }
        WorkUnitCommitOutcome::PublicationConflict { conflicts } => {
            Err(publication_conflict_error(&conflicts))
        }
        WorkUnitCommitOutcome::PolicyMismatch => Err(work_unit_policy_mismatch()),
        WorkUnitCommitOutcome::Closing => Err(closed_work_unit()),
        WorkUnitCommitOutcome::Committed => Err(closed_work_unit()),
        WorkUnitCommitOutcome::Expired => Err(expired_work_unit()),
        WorkUnitCommitOutcome::Replayed { .. } => Err(provider_corruption(
            "work-unit idempotency was replayed after the controller admitted it",
        )),
        WorkUnitCommitOutcome::IdempotencyConflict => Err(idempotency_conflict()),
    }
}

fn publication_conflict_error(conflicts: &[WorkUnitConflict]) -> BackendError {
    BackendError::entity_conflicts(
        conflicts
            .iter()
            .map(|conflict| EntityVersionConflict {
                entity_ref: EntityRef {
                    entity_type: conflict.key.entity_type.clone(),
                    id: conflict.key.entity_id.clone(),
                },
                current_versions: conflict
                    .current
                    .as_ref()
                    .map_or_else(Vec::new, |snapshot| snapshot.head_versions.clone()),
            })
            .collect(),
    )
}

fn entity_conflict_error(
    conflict: &WorkUnitConflict,
    current_versions: Vec<String>,
) -> BackendError {
    BackendError::entity_conflicts(vec![EntityVersionConflict {
        entity_ref: EntityRef {
            entity_type: conflict.key.entity_type.clone(),
            id: conflict.key.entity_id.clone(),
        },
        current_versions,
    }])
}

fn closed_work_unit() -> BackendError {
    BackendError::new(
        BackendErrorReason::InvalidRequest,
        "work unit is already committed; use a new configured identity",
    )
}

fn work_unit_policy_mismatch() -> BackendError {
    BackendError::new(
        BackendErrorReason::InvalidRequest,
        "work unit identity is already bound to a different configured policy",
    )
}

fn expired_work_unit() -> BackendError {
    BackendError::new(
        BackendErrorReason::WorkUnitExpired,
        "work unit expired before publication",
    )
}

fn reject_fallback(fallback: ConflictFallback) -> Result<(), BackendError> {
    match fallback {
        ConflictFallback::Mvcc => Ok(()),
        ConflictFallback::Reject => Err(BackendError::new(
            BackendErrorReason::VersionConflict,
            "candidate is outside the configured merge rules",
        )),
    }
}

fn invalid_request(error: impl std::fmt::Display) -> BackendError {
    BackendError::new(BackendErrorReason::InvalidRequest, error.to_string())
}

fn conflict_backend_error(error: crate::ConflictError) -> BackendError {
    match error {
        crate::ConflictError::Rejected => {
            BackendError::new(BackendErrorReason::VersionConflict, error.to_string())
        }
        _ => BackendError::new(BackendErrorReason::Overloaded, error.to_string()),
    }
}

fn provider_backend_error(error: ProviderError) -> BackendError {
    let reason = match error.reason() {
        ProviderErrorReason::Internal
        | ProviderErrorReason::Unauthenticated
        | ProviderErrorReason::Unavailable => BackendErrorReason::Overloaded,
        ProviderErrorReason::DeadlineExceeded => BackendErrorReason::DeadlineExceeded,
    };
    BackendError::new(reason, error.to_string())
}

fn provider_corruption(message: &str) -> BackendError {
    BackendError::new(BackendErrorReason::Overloaded, message)
}

fn with_current_versions(mut error: BackendError, current_versions: &[String]) -> BackendError {
    if error.reason == BackendErrorReason::VersionConflict && error.current_versions.is_empty() {
        error.current_versions = current_versions.to_vec();
    }
    error
}

fn not_found() -> BackendError {
    BackendError::new(BackendErrorReason::NotFound, "entity was not found")
}

fn unix_time_ms() -> Result<u64, BackendError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(invalid_request)
}
