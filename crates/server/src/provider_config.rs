use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Arc,
};

use patchouli_backend::BackendConfig;
use patchouli_provider::{Provider, ProviderError};
use patchouli_provider_remote::RemoteProvider;
use patchouli_provider_router::{RoutingProvider, ScopeRoute};
use patchouli_provider_sqlite::SqliteProvider;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfig {
    #[serde(rename = "$schema")]
    pub schema_uri: String,
    pub version: u16,
    pub providers: BTreeMap<String, ProviderDefinition>,
    pub routing: ProviderRouting,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProviderDefinition {
    Local { database: PathBuf },
    Remote { endpoint: String, token_env: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderRouting {
    pub default: String,
    pub rules: Vec<ScopeRoute>,
}

#[derive(Debug, Error)]
pub enum ProviderConfigError {
    #[error("provider configuration I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid provider configuration JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid provider configuration at {path}: {message}")]
    Invalid { path: String, message: String },
    #[error(transparent)]
    Provider(#[from] ProviderError),
}

impl ProviderConfig {
    pub fn from_json(input: &str, backend: &BackendConfig) -> Result<Self, ProviderConfigError> {
        let config: Self = serde_json::from_str(input)?;
        config.validate(backend)?;
        Ok(config)
    }

    pub fn validate(&self, backend: &BackendConfig) -> Result<(), ProviderConfigError> {
        if self.version != 1 {
            return Err(invalid(
                "version",
                "only provider configuration version 1 is supported",
            ));
        }
        match self.providers.get("local") {
            Some(ProviderDefinition::Local { .. }) => {}
            Some(ProviderDefinition::Remote { .. }) => {
                return Err(invalid(
                    "providers.local",
                    "provider local must use kind local",
                ));
            }
            None => return Err(invalid("providers.local", "a local provider is required")),
        }
        for (name, provider) in &self.providers {
            if name.is_empty() {
                return Err(invalid("providers", "provider names must not be empty"));
            }
            match provider {
                ProviderDefinition::Local { database } => {
                    if name != "local" {
                        return Err(invalid(
                            format!("providers.{name}"),
                            "the local database provider must be named local",
                        ));
                    }
                    if database.as_os_str().is_empty() {
                        return Err(invalid(
                            format!("providers.{name}.database"),
                            "database path must not be empty",
                        ));
                    }
                }
                ProviderDefinition::Remote {
                    endpoint,
                    token_env,
                } => {
                    if endpoint.is_empty() {
                        return Err(invalid(
                            format!("providers.{name}.endpoint"),
                            "remote endpoint must not be empty",
                        ));
                    }
                    if token_env.is_empty() {
                        return Err(invalid(
                            format!("providers.{name}.token_env"),
                            "token environment variable must not be empty",
                        ));
                    }
                    RemoteProvider::validate_endpoint(endpoint).map_err(|error| {
                        invalid(format!("providers.{name}.endpoint"), error.to_string())
                    })?;
                }
            }
        }
        if !self.providers.contains_key(&self.routing.default) {
            return Err(invalid(
                "routing.default",
                format!("provider {:?} is not configured", self.routing.default),
            ));
        }
        let scope_fields = backend
            .entity_identity
            .scope_by
            .iter()
            .collect::<BTreeSet<_>>();
        for (index, route) in self.routing.rules.iter().enumerate() {
            let root = format!("routing.rules[{index}]");
            if route.scope.is_empty() {
                return Err(invalid(
                    format!("{root}.scope"),
                    "a route must match at least one scope field",
                ));
            }
            if !self.providers.contains_key(&route.provider) {
                return Err(invalid(
                    format!("{root}.provider"),
                    format!("provider {:?} is not configured", route.provider),
                ));
            }
            for (field, value) in &route.scope {
                if !scope_fields.contains(field) {
                    return Err(invalid(
                        format!("{root}.scope.{field}"),
                        "route fields must be configured by entity_identity.scope_by",
                    ));
                }
                backend
                    .meta_fields
                    .get(field)
                    .expect("scope fields are validated by BackendConfig")
                    .validate_value(value)
                    .map_err(|message| invalid(format!("{root}.scope.{field}"), message))?;
            }
        }
        Ok(())
    }
}

pub async fn load_provider(
    path: &Path,
    backend: &BackendConfig,
) -> Result<Arc<dyn Provider>, ProviderConfigError> {
    let input = std::fs::read_to_string(path)?;
    let config = ProviderConfig::from_json(&input, backend)?;
    let base = path.parent().unwrap_or_else(|| Path::new("."));
    let mut providers = BTreeMap::<String, Arc<dyn Provider>>::new();
    for (name, definition) in &config.providers {
        let provider: Arc<dyn Provider> = match definition {
            ProviderDefinition::Local { database } => {
                let database = if database.is_absolute() {
                    database.clone()
                } else {
                    base.join(database)
                };
                Arc::new(
                    SqliteProvider::open(database)
                        .await
                        .map_err(|error| ProviderError::new(error.to_string()))?,
                )
            }
            ProviderDefinition::Remote {
                endpoint,
                token_env,
            } => {
                let token = std::env::var(token_env).map_err(|_| {
                    invalid(
                        format!("providers.{name}.token_env"),
                        format!("environment variable {token_env:?} is not set"),
                    )
                })?;
                Arc::new(RemoteProvider::connect(endpoint, token).await?)
            }
        };
        providers.insert(name.clone(), provider);
    }
    Ok(Arc::new(RoutingProvider::new(
        providers,
        config.routing.default,
        config.routing.rules,
    )?))
}

fn invalid(path: impl Into<String>, message: impl Into<String>) -> ProviderConfigError {
    ProviderConfigError::Invalid {
        path: path.into(),
        message: message.into(),
    }
}
