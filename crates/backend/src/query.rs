use std::collections::BTreeSet;

use patchouli_provider::{
    RetrieveCursor, RetrieveFilter, RetrieveFilterOperator, RetrieveOrder, RetrieveQuery,
};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{BackendError, BackendErrorReason};

pub(crate) fn parse_query(
    scope_json: String,
    entity_types: Vec<String>,
    query_json: &str,
    limit: usize,
) -> Result<RetrieveQuery, BackendError> {
    let instruction: Value = serde_json::from_str(query_json)
        .map_err(|error| invalid(format!("retrieval query must be a JSON object: {error}")))?;
    let object = instruction
        .as_object()
        .ok_or_else(|| invalid("retrieval query must be a JSON object"))?;
    reject_unknown_fields(object)?;

    let text = optional_non_empty_string(object, "text")?;
    let entity_ids = optional_string_set(object, "ids")?;
    let filters = parse_filters(object.get("where"))?;
    let order = parse_order(object.get("order"), text.is_some())?;
    let mut query = RetrieveQuery {
        scope_json,
        entity_types: Some(entity_types),
        text,
        entity_ids,
        filters,
        order,
        fingerprint: String::new(),
        after: None,
        limit,
    };
    query.fingerprint = fingerprint(&query)?;
    query.after = parse_cursor(object.get("cursor"), order, &query.fingerprint)?;
    Ok(query)
}

pub(crate) fn encode_cursor(cursor: &RetrieveCursor) -> Result<String, BackendError> {
    serde_json::to_string(cursor).map_err(invalid)
}

fn reject_unknown_fields(object: &Map<String, Value>) -> Result<(), BackendError> {
    const FIELDS: [&str; 5] = ["text", "ids", "where", "order", "cursor"];
    if let Some(field) = object
        .keys()
        .find(|field| !FIELDS.contains(&field.as_str()))
    {
        return Err(invalid(format!(
            "retrieval query contains unknown field {field:?}"
        )));
    }
    Ok(())
}

fn optional_non_empty_string(
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<String>, BackendError> {
    let Some(value) = object.get(field) else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| invalid(format!("retrieval query {field:?} must be a string")))?
        .trim();
    if value.is_empty() {
        return Err(invalid(format!(
            "retrieval query {field:?} must not be empty"
        )));
    }
    Ok(Some(value.to_owned()))
}

fn optional_string_set(
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<Vec<String>>, BackendError> {
    let Some(value) = object.get(field) else {
        return Ok(None);
    };
    let values = value
        .as_array()
        .ok_or_else(|| invalid(format!("retrieval query {field:?} must be an array")))?;
    if values.is_empty() {
        return Err(invalid(format!(
            "retrieval query {field:?} must not be empty"
        )));
    }
    let mut unique = BTreeSet::new();
    for value in values {
        let value = value
            .as_str()
            .ok_or_else(|| invalid(format!("retrieval query {field:?} entries must be strings")))?;
        if value.trim().is_empty() || !unique.insert(value.to_owned()) {
            return Err(invalid(format!(
                "retrieval query {field:?} entries must be non-empty and unique"
            )));
        }
    }
    Ok(Some(unique.into_iter().collect()))
}

fn parse_filters(value: Option<&Value>) -> Result<Vec<RetrieveFilter>, BackendError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let object = value
        .as_object()
        .ok_or_else(|| invalid("retrieval query \"where\" must be an object"))?;
    object
        .iter()
        .map(|(pointer, condition)| {
            validate_pointer(pointer)?;
            let (operator, operand) = parse_condition(condition)?;
            Ok(RetrieveFilter {
                pointer: pointer.clone(),
                operator,
                value_json: serde_json::to_string(operand).map_err(invalid)?,
            })
        })
        .collect()
}

fn parse_condition(value: &Value) -> Result<(RetrieveFilterOperator, &Value), BackendError> {
    let Some(object) = value.as_object() else {
        return Ok((RetrieveFilterOperator::Equal, value));
    };
    if object.len() != 1 {
        return Ok((RetrieveFilterOperator::Equal, value));
    }
    let (name, operand) = object.iter().next().expect("one condition entry");
    let operator = match name.as_str() {
        "$eq" => RetrieveFilterOperator::Equal,
        "$ne" => RetrieveFilterOperator::NotEqual,
        "$lt" => RetrieveFilterOperator::LessThan,
        "$lte" => RetrieveFilterOperator::LessThanOrEqual,
        "$gt" => RetrieveFilterOperator::GreaterThan,
        "$gte" => RetrieveFilterOperator::GreaterThanOrEqual,
        "$contains" => RetrieveFilterOperator::Contains,
        name if name.starts_with('$') => {
            return Err(invalid(format!(
                "retrieval query contains unknown filter operator {name:?}"
            )));
        }
        _ => return Ok((RetrieveFilterOperator::Equal, value)),
    };
    Ok((operator, operand))
}

fn validate_pointer(pointer: &str) -> Result<(), BackendError> {
    if !pointer.starts_with('/') {
        return Err(invalid(format!(
            "retrieval filter path {pointer:?} must be an RFC 6901 JSON pointer"
        )));
    }
    let bytes = pointer.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'~'
            && (index + 1 == bytes.len() || !matches!(bytes[index + 1], b'0' | b'1'))
        {
            return Err(invalid(format!(
                "retrieval filter path {pointer:?} contains an invalid escape"
            )));
        }
        index += 1;
    }
    Ok(())
}

fn parse_order(value: Option<&Value>, has_text: bool) -> Result<RetrieveOrder, BackendError> {
    let Some(value) = value else {
        return Ok(if has_text {
            RetrieveOrder::Relevance
        } else {
            RetrieveOrder::Newest
        });
    };
    match value.as_str() {
        Some("relevance") if has_text => Ok(RetrieveOrder::Relevance),
        Some("relevance") => Err(invalid("relevance order requires retrieval query text")),
        Some("newest") => Ok(RetrieveOrder::Newest),
        Some("oldest") => Ok(RetrieveOrder::Oldest),
        Some("id_asc") => Ok(RetrieveOrder::IdAscending),
        Some("id_desc") => Ok(RetrieveOrder::IdDescending),
        _ => Err(invalid(
            "retrieval query order must be relevance, newest, oldest, id_asc, or id_desc",
        )),
    }
}

fn parse_cursor(
    value: Option<&Value>,
    order: RetrieveOrder,
    fingerprint: &str,
) -> Result<Option<RetrieveCursor>, BackendError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let encoded = value
        .as_str()
        .ok_or_else(|| invalid("retrieval query cursor must be a string"))?;
    let cursor: RetrieveCursor = serde_json::from_str(encoded)
        .map_err(|error| invalid(format!("invalid retrieval cursor: {error}")))?;
    if cursor.order != order
        || cursor.query_fingerprint != fingerprint
        || !cursor.score.is_finite()
        || cursor.entity_type.is_empty()
        || cursor.entity_id.is_empty()
    {
        return Err(invalid("retrieval cursor does not match this query"));
    }
    Ok(Some(cursor))
}

fn fingerprint(query: &RetrieveQuery) -> Result<String, BackendError> {
    #[derive(Serialize)]
    struct QueryIdentity<'a> {
        scope_json: &'a str,
        entity_types: &'a Option<Vec<String>>,
        text: &'a Option<String>,
        entity_ids: &'a Option<Vec<String>>,
        filters: &'a [RetrieveFilter],
        order: RetrieveOrder,
    }

    let identity = QueryIdentity {
        scope_json: &query.scope_json,
        entity_types: &query.entity_types,
        text: &query.text,
        entity_ids: &query.entity_ids,
        filters: &query.filters,
        order: query.order,
    };
    let bytes = serde_json::to_vec(&identity).map_err(invalid)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn invalid(error: impl std::fmt::Display) -> BackendError {
    BackendError::new(BackendErrorReason::InvalidRequest, error.to_string())
}
