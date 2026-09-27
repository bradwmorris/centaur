use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};

use centaur_sandbox_core::{SandboxId, SandboxSpec};
use centaur_session_runtime::SandboxRuntime;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::ApiError;

pub const CURATOR_MODEL: &str = "gpt-6-luna";
const MAX_INPUT_BYTES: usize = 256 * 1024;
const MAX_SCHEMA_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_IDEMPOTENCY_ENTRIES: usize = 256;

#[derive(Clone)]
pub struct CuratorInferenceRuntime {
    inner: Arc<Inner>,
}

struct Inner {
    sandbox: SandboxRuntime,
    spec: SandboxSpec,
    timeout: Duration,
    cache: Mutex<IdempotencyCache>,
    request_gates: RequestGates,
}

#[derive(Default)]
struct RequestGates(Mutex<BTreeMap<String, Weak<tokio::sync::Mutex<()>>>>);

impl RequestGates {
    fn for_request(&self, request_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut gates = self.0.lock().unwrap_or_else(|p| p.into_inner());
        // Weak entries live only while a request owns its gate, keeping the map
        // bounded by concurrent requests rather than historical request IDs.
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = gates.get(request_id).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        gates.insert(request_id.to_owned(), Arc::downgrade(&gate));
        gate
    }
}

struct SandboxCleanup {
    runtime: SandboxRuntime,
    id: Option<SandboxId>,
}

impl Drop for SandboxCleanup {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            let runtime = self.runtime.clone();
            tokio::spawn(async move {
                let _ =
                    tokio::time::timeout(Duration::from_secs(30), runtime.stop_sandbox(&id)).await;
            });
        }
    }
}

#[derive(Default)]
struct IdempotencyCache {
    values: BTreeMap<String, ([u8; 32], CuratorInferenceResponse)>,
    order: VecDeque<String>,
}

impl IdempotencyCache {
    fn get(
        &self,
        request_id: &str,
        digest: &[u8; 32],
    ) -> Result<Option<CuratorInferenceResponse>, ApiError> {
        match self.values.get(request_id) {
            Some((cached_digest, response)) if cached_digest == digest => {
                Ok(Some(response.clone()))
            }
            Some(_) => Err(ApiError::BadRequest(
                "request_id was already used with different input".to_owned(),
            )),
            None => Ok(None),
        }
    }

    fn insert(&mut self, request_id: String, digest: [u8; 32], response: CuratorInferenceResponse) {
        while self.order.len() >= MAX_IDEMPOTENCY_ENTRIES {
            if let Some(oldest) = self.order.pop_front() {
                self.values.remove(&oldest);
            }
        }
        self.order.push_back(request_id.clone());
        self.values.insert(request_id, (digest, response));
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CuratorInferenceRequest {
    pub request_id: String,
    #[serde(default = "default_model")]
    pub model: String,
    pub system_prompt: String,
    pub input: String,
    pub output_schema: Value,
    #[serde(default = "default_reasoning_effort")]
    pub reasoning_effort: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CuratorInferenceResponse {
    pub request_id: String,
    pub execution_id: String,
    pub model: String,
    pub provider: String,
    pub harness: String,
    pub authentication_mode: String,
    pub billing_basis: String,
    pub upstream: String,
    pub reasoning_effort: String,
    pub output: Value,
    pub usage: Option<Value>,
    pub duration_ms: u64,
}

/// Only bounded identifiers and allowlisted categories cross the HTTP/log boundary.
/// Never add provider messages, raw stderr, prompts, or arbitrary error codes here.
#[derive(Clone, Debug, Serialize)]
pub struct CuratorFailure {
    pub request_id: String,
    pub execution_id: String,
    pub model: String,
    pub reasoning_effort: String,
    pub classification: &'static str,
    pub provider_status: Option<u16>,
    pub provider_code: Option<&'static str>,
    pub retryable: bool,
    pub duration_ms: u64,
}

#[derive(Clone, Copy)]
struct FailureCause {
    classification: &'static str,
    provider_status: Option<u16>,
    provider_code: Option<&'static str>,
    retryable: bool,
}

impl FailureCause {
    fn new(classification: &'static str, retryable: bool) -> Self {
        Self {
            classification,
            retryable,
            provider_status: None,
            provider_code: None,
        }
    }

    fn error(
        self,
        request: &CuratorInferenceRequest,
        execution_id: &str,
        started: Instant,
    ) -> ApiError {
        tracing::warn!(
            component = "context_curator_inference",
            request_id = if safe_request_id(&request.request_id) {
                request.request_id.as_str()
            } else {
                ""
            },
            execution_id,
            classification = self.classification,
            provider_status = self.provider_status,
            provider_code = self.provider_code,
            retryable = self.retryable,
            duration_ms = started.elapsed().as_millis() as u64,
            "Context inference failed"
        );
        ApiError::CuratorFailure(Box::new(CuratorFailure {
            request_id: if safe_request_id(&request.request_id) {
                request.request_id.clone()
            } else {
                String::new()
            },
            execution_id: execution_id.to_owned(),
            model: if request.model == CURATOR_MODEL {
                CURATOR_MODEL
            } else {
                "unsupported"
            }
            .to_owned(),
            reasoning_effort: if supported_effort(&request.reasoning_effort) {
                request.reasoning_effort.as_str()
            } else {
                "unsupported"
            }
            .to_owned(),
            classification: self.classification,
            provider_status: self.provider_status,
            provider_code: self.provider_code,
            retryable: self.retryable,
            duration_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
        }))
    }
}

fn safe_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}

fn supported_effort(effort: &str) -> bool {
    matches!(
        effort,
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    )
}

fn classify_failure(event: &Value) -> FailureCause {
    let error = event
        .pointer("/params/turn/error")
        .or_else(|| event.pointer("/params/error"))
        .or_else(|| event.get("error"))
        .unwrap_or(event);
    let info = error.get("codexErrorInfo").unwrap_or(&Value::Null);
    let status = error
        .get("status")
        .or_else(|| error.get("status_code"))
        .or_else(|| error.get("httpStatusCode"))
        .or_else(|| info.pointer("/httpConnectionFailed/httpStatusCode"))
        .or_else(|| info.pointer("/responseStreamConnectionFailed/httpStatusCode"))
        .and_then(Value::as_u64)
        .and_then(|n| u16::try_from(n).ok())
        .filter(|n| (100..600).contains(n));
    let code = error.get("code").and_then(Value::as_str);
    // Messages are inspected locally for known causes, never retained or emitted.
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let (classification, retryable, provider_code) = match code {
        Some("model_not_found" | "unsupported_model") => {
            ("unsupported_model", false, Some("unsupported_model"))
        }
        Some("invalid_api_key" | "authentication_error") => {
            ("authentication", false, Some("authentication_error"))
        }
        Some("insufficient_quota" | "usage_limit_reached") => {
            ("quota", false, Some("insufficient_quota"))
        }
        Some("rate_limit_exceeded") => ("rate_limit", true, Some("rate_limit_exceeded")),
        _ if message.contains("model")
            && (message.contains("not supported")
                || message.contains("does not exist")
                || message.contains("not found")) =>
        {
            ("unsupported_model", false, Some("unsupported_model"))
        }
        _ if message.contains("workspace routing")
            || message.contains("unauthorized")
            || message.contains("authentication")
            || matches!(status, Some(401 | 403)) =>
        {
            ("authentication", false, None)
        }
        _ if message.contains("usage limit")
            || message.contains("insufficient quota")
            || info == "usageLimitExceeded" =>
        {
            ("quota", false, Some("insufficient_quota"))
        }
        _ if status == Some(429) => ("rate_limit", true, Some("rate_limit_exceeded")),
        _ if status.is_some_and(|n| n >= 500)
            || info.get("httpConnectionFailed").is_some()
            || info.get("responseStreamConnectionFailed").is_some() =>
        {
            ("transport", true, None)
        }
        _ => ("model_failure", false, None),
    };
    FailureCause {
        classification,
        retryable,
        provider_status: status,
        provider_code,
    }
}

fn safe_failure(
    error: ApiError,
    request: &CuratorInferenceRequest,
    execution_id: &str,
    started: Instant,
) -> ApiError {
    let cause = match error {
        ApiError::CuratorFailure(_) => return error,
        ApiError::BadRequest(_) => FailureCause::new("invalid_request", false),
        ApiError::PayloadTooLarge(_) => FailureCause::new("output_limit", false),
        _ => FailureCause::new("transport", true),
    };
    cause.error(request, execution_id, started)
}

fn default_model() -> String {
    CURATOR_MODEL.to_owned()
}

fn default_reasoning_effort() -> String {
    "low".to_owned()
}

fn memory_only_curator_schema() -> Value {
    serde_json::from_str(include_str!("curator_contracts/extraction-v1.json")).unwrap()
}

fn chat_summary_schema() -> Value {
    serde_json::from_str(include_str!("curator_contracts/chat-summary-v1.json")).unwrap()
}

fn legacy_memory_maintenance_schema() -> Value {
    serde_json::from_str(include_str!("curator_contracts/maintenance-v1.json")).unwrap()
}

fn is_maintenance(schema: &Value) -> bool {
    schema == &memory_maintenance_schema() || schema == &legacy_memory_maintenance_schema()
}

impl CuratorInferenceRuntime {
    pub fn new(sandbox: SandboxRuntime, spec: SandboxSpec, timeout: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                sandbox,
                spec,
                timeout,
                cache: Mutex::new(IdempotencyCache::default()),
                request_gates: RequestGates::default(),
            }),
        }
    }

    pub async fn infer(
        &self,
        request: CuratorInferenceRequest,
    ) -> Result<CuratorInferenceResponse, ApiError> {
        let started_at = Instant::now();
        let execution_id = uuid::Uuid::new_v4().to_string();
        validate_request(&request)
            .map_err(|error| safe_failure(error, &request, &execution_id, started_at))?;
        // Coalesce matching request IDs while unrelated consumers run independently.
        // This is not durable exactly-once inference across restarts or cache eviction.
        let request_gate = self.inner.request_gates.for_request(&request.request_id);
        let _permit = tokio::time::timeout(self.inner.timeout, request_gate.lock())
            .await
            .map_err(|_| {
                FailureCause::new("timeout", true).error(&request, &execution_id, started_at)
            })?;
        let digest: [u8; 32] = Sha256::digest(
            serde_json::to_vec(&request)
                .map_err(|error| ApiError::BadRequest(error.to_string()))?,
        )
        .into();
        if let Some(cached) = self
            .cached_response(&request.request_id, &digest)
            .map_err(|error| safe_failure(error, &request, &execution_id, started_at))?
        {
            return Ok(cached);
        }

        let (sandbox_id, io) = self
            .inner
            .sandbox
            .create_running_io(self.inner.spec.clone())
            .await
            .map_err(|error| safe_failure(error.into(), &request, &execution_id, started_at))?;
        let mut cleanup = SandboxCleanup {
            runtime: self.inner.sandbox.clone(),
            id: Some(sandbox_id.clone()),
        };
        let timeout = self.inner.timeout;
        let result = tokio::time::timeout(
            timeout,
            run_inference(io, &request, &execution_id, started_at),
        )
        .await;
        let stop_result = tokio::time::timeout(
            Duration::from_secs(30),
            self.inner.sandbox.stop_sandbox(&sandbox_id),
        )
        .await;
        if matches!(stop_result, Ok(Ok(()))) {
            cleanup.id = None;
        }
        if !matches!(stop_result, Ok(Ok(()))) {
            tracing::warn!(sandbox_id = %sandbox_id.as_str(), request_id = %request.request_id, execution_id = %execution_id, "failed to stop curator inference sandbox");
        }
        let response = match result {
            Ok(result) => {
                result.map_err(|error| safe_failure(error, &request, &execution_id, started_at))?
            }
            Err(_) => {
                return Err(FailureCause::new("timeout", true).error(
                    &request,
                    &execution_id,
                    started_at,
                ));
            }
        };
        self.insert_cached(request.request_id, digest, response.clone());
        tracing::info!(
            component = "context_curator_inference",
            request_id = %response.request_id,
            execution_id = %response.execution_id,
            model = %response.model,
            provider = %response.provider,
            harness = %response.harness,
            authentication_mode = %response.authentication_mode,
            billing_basis = %response.billing_basis,
            upstream = %response.upstream,
            reasoning_effort = %response.reasoning_effort,
            usage_reported = response.usage.is_some(),
            duration_ms = response.duration_ms,
            "Context Curator inference completed"
        );
        Ok(response)
    }

    fn cached_response(
        &self,
        request_id: &str,
        digest: &[u8; 32],
    ) -> Result<Option<CuratorInferenceResponse>, ApiError> {
        let cache = self
            .inner
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.get(request_id, digest)
    }

    fn insert_cached(
        &self,
        request_id: String,
        digest: [u8; 32],
        response: CuratorInferenceResponse,
    ) {
        let mut cache = self
            .inner
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.insert(request_id, digest, response);
    }
}

fn memory_maintenance_schema() -> Value {
    serde_json::from_str(include_str!("curator_contracts/maintenance-v2.json")).unwrap()
}

fn validate_request(request: &CuratorInferenceRequest) -> Result<(), ApiError> {
    if request.model != CURATOR_MODEL {
        return Err(ApiError::BadRequest("unsupported curator model".to_owned()));
    }
    let request_id = request.request_id.as_str();
    if !safe_request_id(request_id) {
        return Err(ApiError::BadRequest(
            "request_id must contain 1 to 128 ASCII letters, digits, or -_.:".to_owned(),
        ));
    }
    let input_bytes = request.system_prompt.len() + request.input.len();
    if input_bytes > MAX_INPUT_BYTES {
        return Err(ApiError::PayloadTooLarge(format!(
            "curator input exceeds {MAX_INPUT_BYTES} bytes"
        )));
    }
    if serde_json::to_vec(&request.output_schema)
        .map_err(|error| ApiError::BadRequest(error.to_string()))?
        .len()
        > MAX_SCHEMA_BYTES
    {
        return Err(ApiError::PayloadTooLarge(format!(
            "output_schema exceeds {MAX_SCHEMA_BYTES} bytes"
        )));
    }
    if !request.output_schema.is_object() {
        return Err(ApiError::BadRequest(
            "output_schema must be a JSON object".to_owned(),
        ));
    }
    if request.output_schema != memory_only_curator_schema()
        && !is_maintenance(&request.output_schema)
        && request.output_schema != chat_summary_schema()
    {
        return Err(ApiError::BadRequest(
            "output_schema must match a supported Context inference contract".to_owned(),
        ));
    }
    if is_maintenance(&request.output_schema) && input_bytes > 28_000 {
        return Err(ApiError::PayloadTooLarge(
            "maintenance input exceeds 28000 bytes".into(),
        ));
    }
    if !supported_effort(&request.reasoning_effort) {
        return Err(ApiError::BadRequest(
            "unsupported reasoning_effort".to_owned(),
        ));
    }
    Ok(())
}

async fn run_inference(
    io: centaur_sandbox_core::SandboxIoParts,
    request: &CuratorInferenceRequest,
    execution_id: &str,
    started_at: Instant,
) -> Result<CuratorInferenceResponse, ApiError> {
    let centaur_sandbox_core::SandboxIoParts {
        mut stdin,
        stdout,
        stderr,
        guard: _guard,
        ..
    } = io;
    // Both futures belong to this request. Dropping the request/timeout drops
    // stderr and the attach guard too; no detached reader survives an early return.
    let stderr_cause = Arc::new(Mutex::new(None));
    let retained = stderr_cause.clone();
    let drain_stderr = async move {
        let mut reader = BufReader::new(stderr).take(MAX_OUTPUT_BYTES as u64);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let event = serde_json::from_slice::<Value>(&line)
                        .unwrap_or_else(|_| json!({"message": String::from_utf8_lossy(&line)}));
                    let cause = classify_failure(&event);
                    if cause.classification != "model_failure" {
                        *retained.lock().unwrap_or_else(|p| p.into_inner()) = Some(cause);
                    }
                }
            }
        }
        std::future::pending::<()>().await;
    };
    let inference = async {
        let prompt = format!(
            "{}\n\n<curator_input>\n{}\n</curator_input>\n\nReturn only the JSON value required by the supplied schema. Do not use tools.",
            request.system_prompt, request.input
        );
        let line = json!({
            "type": "user",
            "client_user_message_id": request.request_id,
            "model": CURATOR_MODEL,
            "provider": "openai",
            "reasoning": request.reasoning_effort,
            "output_schema": request.output_schema,
            "text": prompt,
        });
        let mut encoded = serde_json::to_vec(&line)?;
        encoded.push(b'\n');
        stdin
            .write_all(&encoded)
            .await
            .map_err(|error| ApiError::Internal(format!("write curator sandbox input: {error}")))?;
        stdin
            .flush()
            .await
            .map_err(|error| ApiError::Internal(format!("flush curator sandbox input: {error}")))?;

        let output_limit = if is_maintenance(&request.output_schema) {
            8_000
        } else {
            MAX_OUTPUT_BYTES
        };
        let mut lines = BufReader::new(stdout.take((MAX_OUTPUT_BYTES + 1) as u64)).lines();
        let mut total_bytes = 0;
        let mut answer = String::new();
        let mut observed_usage = None;
        let usage = loop {
            let Some(line) = lines.next_line().await.map_err(|error| {
                ApiError::Internal(format!("read curator sandbox output: {error}"))
            })?
            else {
                return Err(ApiError::ServiceUnavailable(
                    "curator sandbox ended before turn completion".to_owned(),
                ));
            };
            total_bytes += line.len() + 1;
            if total_bytes > MAX_OUTPUT_BYTES || answer.len() > output_limit {
                return Err(ApiError::PayloadTooLarge(
                    "curator model output exceeded its byte limit".to_owned(),
                ));
            }
            let event: Value = serde_json::from_str(&line).map_err(|_| {
                FailureCause::new("malformed_output", false).error(
                    request,
                    execution_id,
                    started_at,
                )
            })?;
            if contains_tool_activity(&event) {
                return Err(FailureCause::new("prohibited_tool", false).error(
                    request,
                    execution_id,
                    started_at,
                ));
            }
            let method = event.get("method").and_then(Value::as_str);
            if method == Some("thread/tokenUsage/updated") {
                observed_usage = event
                    .pointer("/params/tokenUsage/last")
                    .or_else(|| event.pointer("/params/token_usage/last"))
                    .cloned();
            }
            if matches!(
                method,
                Some("item/agentMessage/delta" | "item/agent_message/delta")
            ) && let Some(delta) = event.pointer("/params/delta").and_then(Value::as_str)
            {
                answer.push_str(delta);
            }
            if method == Some("item/completed")
                && matches!(
                    event.pointer("/params/item/type").and_then(Value::as_str),
                    Some("agentMessage" | "agent_message")
                )
                && let Some(text) = event.pointer("/params/item/text").and_then(Value::as_str)
            {
                answer.clear();
                answer.push_str(text);
            }
            if matches!(method, Some("turn/completed" | "turn/failed" | "error")) {
                let failed = method != Some("turn/completed")
                    || event.pointer("/params/turn/status").and_then(Value::as_str)
                        != Some("completed")
                    || event
                        .pointer("/params/turn/error")
                        .is_some_and(|v| !v.is_null());
                if failed {
                    // The harness owns bounded internal retries; do not launch another turn.
                    if method == Some("error")
                        && event.pointer("/params/willRetry").and_then(Value::as_bool) == Some(true)
                    {
                        continue;
                    }
                    return Err(classify_failure(&event).error(request, execution_id, started_at));
                }
            }
            if method == Some("turn/completed") {
                let usage = event
                    .pointer("/params/turn/usage")
                    .or_else(|| event.pointer("/params/usage"))
                    .cloned()
                    .or(observed_usage);
                break usage;
            }
        };
        if answer.len() > output_limit {
            return Err(ApiError::PayloadTooLarge(
                "curator output exceeded its byte limit".into(),
            ));
        }
        let output: Value = serde_json::from_str(answer.trim()).map_err(|_| {
            FailureCause::new("malformed_output", false).error(request, execution_id, started_at)
        })?;
        if !matches_contract(&output, &request.output_schema, &request.output_schema) {
            return Err(FailureCause::new("malformed_output", false).error(
                request,
                execution_id,
                started_at,
            ));
        }
        Ok(CuratorInferenceResponse {
            request_id: request.request_id.clone(),
            execution_id: execution_id.to_owned(),
            model: CURATOR_MODEL.to_owned(),
            provider: "openai".to_owned(),
            harness: "codex".to_owned(),
            authentication_mode: "chatgpt_subscription".to_owned(),
            billing_basis: "chatgpt_subscription".to_owned(),
            upstream: "chatgpt.com".to_owned(),
            reasoning_effort: request.reasoning_effort.clone(),
            output,
            usage,
            duration_ms: started_at
                .elapsed()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
        })
    };
    tokio::pin!(inference);
    tokio::pin!(drain_stderr);
    let result = tokio::select! {
        // Consume already available diagnostic lines before a simultaneously
        // ready stdout failure; the bounded drain yields when no data is ready.
        biased;
        () = &mut drain_stderr => unreachable!("stderr drain remains pending"),
        result = &mut inference => result,
    };
    result.map_err(|error| {
        let fallback = matches!(
            &error,
            ApiError::ServiceUnavailable(_) | ApiError::Internal(_)
        ) || matches!(&error, ApiError::CuratorFailure(f) if f.classification == "model_failure");
        if fallback && let Some(cause) = *stderr_cause.lock().unwrap_or_else(|p| p.into_inner()) {
            return cause.error(request, execution_id, started_at);
        }
        safe_failure(error, request, execution_id, started_at)
    })
}

// Validator for the deliberately small, static contract vocabulary above. Never
// call with caller-defined schemas: validate_request must first match a fixture.
fn matches_contract(value: &Value, schema: &Value, root: &Value) -> bool {
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        return reference
            .strip_prefix('#')
            .and_then(|p| root.pointer(p))
            .is_some_and(|s| matches_contract(value, s, root));
    }
    if let Some(variants) = schema.get("anyOf").and_then(Value::as_array) {
        return variants.iter().any(|s| matches_contract(value, s, root));
    }
    if let Some(options) = schema.get("enum").and_then(Value::as_array)
        && !options.contains(value)
    {
        return false;
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("array") => value.as_array().is_some_and(|items| {
            schema
                .get("maxItems")
                .and_then(Value::as_u64)
                .is_none_or(|max| items.len() as u64 <= max)
                && schema
                    .get("items")
                    .is_some_and(|s| items.iter().all(|v| matches_contract(v, s, root)))
        }),
        Some("object") => value.as_object().is_some_and(|object| {
            let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
                return false;
            };
            schema
                .get("required")
                .and_then(Value::as_array)
                .is_some_and(|required| {
                    required
                        .iter()
                        .all(|key| key.as_str().is_some_and(|k| object.contains_key(k)))
                })
                && object.iter().all(|(key, value)| {
                    properties
                        .get(key)
                        .is_some_and(|s| matches_contract(value, s, root))
                })
        }),
        _ => false,
    }
}

fn contains_tool_activity(value: &Value) -> bool {
    ["/params/item/type", "/item/type"]
        .into_iter()
        .filter_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .any(|kind| {
            matches!(
                kind,
                "commandExecution"
                    | "command_execution"
                    | "mcpToolCall"
                    | "mcp_tool_call"
                    | "webSearch"
                    | "web_search"
                    | "fileChange"
                    | "file_change"
                    | "imageGeneration"
                    | "image_generation"
                    | "dynamicToolCall"
                    | "dynamic_tool_call"
                    | "collabAgentToolCall"
                    | "collab_agent_tool_call"
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use centaur_sandbox_core::{SandboxIoGuard, SandboxIoParts};
    use tokio::io::{AsyncReadExt, AsyncWriteExt, duplex};

    fn request() -> CuratorInferenceRequest {
        CuratorInferenceRequest {
            request_id: "request-1".to_owned(),
            model: CURATOR_MODEL.to_owned(),
            system_prompt: "curate".to_owned(),
            input: "evidence".to_owned(),
            output_schema: memory_only_curator_schema(),
            reasoning_effort: "low".to_owned(),
        }
    }

    async fn events_result(
        events: Vec<Value>,
        effort: &str,
        schema: Value,
    ) -> Result<CuratorInferenceResponse, ApiError> {
        let (stdin, mut stdin_reader) = duplex(65536);
        let (mut stdout_writer, stdout) = duplex(65536);
        let (_stderr_writer, stderr) = duplex(64);
        let effort = effort.to_owned();
        let expected_effort = effort.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(&mut stdin_reader);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let input: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(input["model"], CURATOR_MODEL);
            assert_eq!(input["reasoning"], expected_effort);
            for event in events {
                stdout_writer
                    .write_all(format!("{event}\n").as_bytes())
                    .await
                    .unwrap();
            }
        });
        let mut request = request();
        request.reasoning_effort = effort;
        request.output_schema = schema;
        run_inference(
            SandboxIoParts {
                stdin: Box::pin(stdin),
                stdout: Box::pin(stdout),
                stderr: Box::pin(stderr),
                guard: SandboxIoGuard::new(()),
                instance_id: None,
            },
            &request,
            "00000000-0000-4000-8000-000000000001",
            Instant::now(),
        )
        .await
    }

    #[tokio::test]
    async fn all_consumer_contracts_complete_and_preserve_effort() {
        for (schema, output, effort) in [
            (
                memory_only_curator_schema(),
                json!({"create_objects":[],"create_connections":[]}),
                "low",
            ),
            (
                chat_summary_schema(),
                json!({"title":"Example","description":"A synthetic conversation."}),
                "low",
            ),
            (
                legacy_memory_maintenance_schema(),
                json!({"changes":[]}),
                "low",
            ),
            (
                memory_maintenance_schema(),
                json!({"changes":[{"action":"merge","reason":"Identical synthetic evidence","object_id":"one","survivor_id":"two","title":"Event","description":"A synthetic event."}]}),
                "high",
            ),
        ] {
            let mut input = request();
            input.output_schema = schema.clone();
            assert!(validate_request(&input).is_ok());
            let result = events_result(vec![
                json!({"method":"item/completed","params":{"item":{"type":"agentMessage","text":output.to_string()}}}),
                json!({"method":"turn/completed","params":{"turn":{"status":"completed"}}}),
            ], effort, schema).await.unwrap();
            assert_eq!(result.output, output);
            assert_eq!(result.reasoning_effort, effort);
            assert_eq!(result.model, CURATOR_MODEL);
        }
    }

    #[tokio::test]
    async fn terminal_embedded_errors_and_explicit_errors_are_safe_and_distinct() {
        for method in ["turn/completed", "turn/failed", "error"] {
            for (error, classification, retryable) in [
                (
                    json!({"code":"model_not_found","message":"SECRET raw provider body"}),
                    "unsupported_model",
                    false,
                ),
                (
                    json!({"status":401,"message":"SECRET"}),
                    "authentication",
                    false,
                ),
                (
                    json!({"code":"insufficient_quota","status":429,"message":"SECRET"}),
                    "quota",
                    false,
                ),
                (
                    json!({"code":"rate_limit_exceeded","status":429,"message":"SECRET"}),
                    "rate_limit",
                    true,
                ),
                (
                    json!({"codexErrorInfo":{"httpConnectionFailed":{"httpStatusCode":503}},"message":"SECRET"}),
                    "transport",
                    true,
                ),
            ] {
                let event = if method == "error" {
                    json!({"method":method,"params":{"error":error}})
                } else {
                    json!({"method":method,"params":{"turn":{"status":"failed","error":error}}})
                };
                let ApiError::CuratorFailure(failure) =
                    events_result(vec![event], "high", memory_maintenance_schema())
                        .await
                        .unwrap_err()
                else {
                    panic!("missing diagnostics");
                };
                assert_eq!(failure.classification, classification);
                assert_eq!(failure.retryable, retryable);
                assert!(!serde_json::to_string(&failure).unwrap().contains("SECRET"));
            }
        }
    }

    #[tokio::test]
    async fn wrong_shape_and_tool_output_fail_closed() {
        for (event, expected) in [
            (
                json!({"method":"item/completed","params":{"item":{"type":"agentMessage","text":"{\"changes\":[],\"extra\":\"forbidden\"}"}}}),
                "malformed_output",
            ),
            (
                json!({"method":"item/started","params":{"item":{"type":"webSearch"}}}),
                "prohibited_tool",
            ),
        ] {
            let ApiError::CuratorFailure(failure) = events_result(
                vec![
                    event,
                    json!({"method":"turn/completed","params":{"turn":{"status":"completed"}}}),
                ],
                "high",
                memory_maintenance_schema(),
            )
            .await
            .unwrap_err() else {
                panic!("missing diagnostics");
            };
            assert_eq!(failure.classification, expected);
        }
    }

    #[test]
    fn absent_model_is_compatible_but_explicit_other_model_is_rejected() {
        let mut value = serde_json::to_value(request()).unwrap();
        value.as_object_mut().unwrap().remove("model");
        assert_eq!(
            serde_json::from_value::<CuratorInferenceRequest>(value)
                .unwrap()
                .model,
            CURATOR_MODEL
        );
        let mut request = request();
        request.model = "other-model".into();
        assert!(validate_request(&request).is_err());
    }

    #[tokio::test]
    async fn matching_requests_share_a_gate_without_blocking_other_consumers() {
        let gates = RequestGates::default();
        let first = gates.for_request("one");
        let retry = gates.for_request("one");
        let unrelated = gates.for_request("two");
        assert!(Arc::ptr_eq(&first, &retry));
        let held = first.lock().await;
        assert!(retry.try_lock().is_err());
        assert!(unrelated.try_lock().is_ok());
        drop(held);
        assert!(retry.try_lock().is_ok());
        drop((first, retry, unrelated));
        let _third = gates.for_request("three");
        assert_eq!(gates.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn maintenance_is_an_exact_bounded_second_schema() {
        let mut value = request();
        value.output_schema = memory_maintenance_schema();
        assert!(validate_request(&value).is_ok());
        value.input = "x".repeat(28_001);
        assert!(matches!(
            validate_request(&value),
            Err(ApiError::PayloadTooLarge(_))
        ));
        value.input = "evidence".into();
        value.output_schema["additionalProperties"] = json!(true);
        assert!(matches!(
            validate_request(&value),
            Err(ApiError::BadRequest(_))
        ));
    }

    #[test]
    fn validates_bounds_and_reasoning() {
        assert!(validate_request(&request()).is_ok());
        let mut unsafe_id = request();
        unsafe_id.request_id = "\nrequest-1\n".into();
        assert!(validate_request(&unsafe_id).is_err());
        let mut invalid = request();
        invalid.reasoning_effort = "ultra".to_owned();
        assert!(matches!(
            validate_request(&invalid),
            Err(ApiError::BadRequest(_))
        ));
    }

    #[test]
    fn rejects_legacy_and_unsafe_curator_schemas() {
        let legacy_schema = json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["create_objects", "update_objects", "create_connections", "update_connections"],
            "properties": {
                "create_objects": {}, "update_objects": {},
                "create_connections": {}, "update_connections": {}
            }
        });
        let mut unsafe_kind_schema = memory_only_curator_schema();
        unsafe_kind_schema["$defs"]["create_object"]["properties"]["kind"]["enum"] =
            json!(["memory", "task"]);
        let mut permissive_schema = memory_only_curator_schema();
        permissive_schema["$defs"]["create_connection"]["additionalProperties"] = Value::Bool(true);

        for output_schema in [
            legacy_schema,
            unsafe_kind_schema,
            permissive_schema,
            json!({"type": "object"}),
        ] {
            let mut invalid = request();
            invalid.output_schema = output_schema;
            assert!(matches!(
                validate_request(&invalid),
                Err(ApiError::BadRequest(message))
                    if message == "output_schema must match a supported Context inference contract"
            ));
        }
    }

    #[test]
    fn detects_command_and_mcp_tool_activity() {
        assert!(contains_tool_activity(
            &json!({"item": {"type": "commandExecution"}})
        ));
        assert!(contains_tool_activity(
            &json!({"params": {"item": {"type": "mcpToolCall"}}})
        ));
        assert!(!contains_tool_activity(
            &json!({"item": {"type": "agentMessage"}})
        ));
    }

    #[test]
    fn idempotency_cache_replays_only_the_same_request() {
        let response = CuratorInferenceResponse {
            request_id: "request-1".to_owned(),
            execution_id: "execution-1".to_owned(),
            model: CURATOR_MODEL.to_owned(),
            provider: "openai".to_owned(),
            harness: "codex".to_owned(),
            authentication_mode: "chatgpt_subscription".to_owned(),
            billing_basis: "chatgpt_subscription".to_owned(),
            upstream: "chatgpt.com".to_owned(),
            reasoning_effort: "low".to_owned(),
            output: json!({}),
            usage: None,
            duration_ms: 1,
        };
        let mut cache = IdempotencyCache::default();
        cache.insert("request-1".to_owned(), [1; 32], response);
        assert!(cache.get("request-1", &[1; 32]).unwrap().is_some());
        assert!(matches!(
            cache.get("request-1", &[2; 32]),
            Err(ApiError::BadRequest(_))
        ));
    }

    #[tokio::test]
    async fn malformed_output_fails_closed() {
        let (stdin, mut stdin_reader) = duplex(4096);
        let (mut stdout_writer, stdout) = duplex(4096);
        let (stderr_writer, stderr) = duplex(64);
        drop(stderr_writer);
        tokio::spawn(async move {
            let mut input = Vec::new();
            stdin_reader.read_to_end(&mut input).await.ok();
        });
        tokio::spawn(async move {
            stdout_writer.write_all(b"not-json\n").await.unwrap();
        });
        let io = SandboxIoParts {
            stdin: Box::pin(stdin),
            stdout: Box::pin(stdout),
            stderr: Box::pin(stderr),
            guard: SandboxIoGuard::new(()),
            instance_id: None,
        };
        assert!(matches!(
            run_inference(io, &request(), "execution-1", Instant::now()).await,
            Err(ApiError::CuratorFailure(_))
        ));
    }

    #[tokio::test]
    async fn stderr_cause_survives_stdout_eof_without_returning_raw_text() {
        let (stdin, _stdin_reader) = duplex(65536);
        let (stdout_writer, stdout) = duplex(64);
        drop(stdout_writer);
        let (mut stderr_writer, stderr) = duplex(1024);
        stderr_writer
            .write_all(b"workspace routing discovery failed SECRET\n")
            .await
            .unwrap();
        drop(stderr_writer);
        let io = SandboxIoParts {
            stdin: Box::pin(stdin),
            stdout: Box::pin(stdout),
            stderr: Box::pin(stderr),
            guard: SandboxIoGuard::new(()),
            instance_id: None,
        };
        let ApiError::CuratorFailure(failure) =
            run_inference(io, &request(), "execution-1", Instant::now())
                .await
                .unwrap_err()
        else {
            panic!("missing receipt");
        };
        assert_eq!(failure.classification, "authentication");
        assert!(!serde_json::to_string(&failure).unwrap().contains("SECRET"));
    }

    #[tokio::test]
    async fn failure_http_receipt_is_safe_and_correlated() {
        use axum::{body::to_bytes, response::IntoResponse};
        let event = json!({"error":{"code":"invalid_api_key","message":"SECRET prompt and token","status":401}});
        let response = classify_failure(&event)
            .error(
                &request(),
                "00000000-0000-4000-8000-000000000001",
                Instant::now(),
            )
            .into_response();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        );
        let body = to_bytes(response.into_body(), 16384).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["code"], "curator_inference_failed");
        assert_eq!(value["diagnostics"]["request_id"], "request-1");
        assert_eq!(value["diagnostics"]["classification"], "authentication");
        assert_eq!(value["diagnostics"]["provider_status"], 401);
        assert_eq!(value["diagnostics"]["retryable"], false);
        assert!(!String::from_utf8_lossy(&body).contains("SECRET"));
    }

    #[tokio::test]
    async fn caller_timeout_can_cancel_a_hung_inference() {
        struct DropProbe(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for DropProbe {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (stdin, mut stdin_reader) = duplex(4096);
        let (_stdout_writer, stdout) = duplex(4096);
        let (stderr_writer, stderr) = duplex(64);
        drop(stderr_writer);
        tokio::spawn(async move {
            let mut input = Vec::new();
            stdin_reader.read_to_end(&mut input).await.ok();
        });
        let io = SandboxIoParts {
            stdin: Box::pin(stdin),
            stdout: Box::pin(stdout),
            stderr: Box::pin(stderr),
            guard: SandboxIoGuard::new(DropProbe(dropped.clone())),
            instance_id: None,
        };
        assert!(
            tokio::time::timeout(
                Duration::from_millis(10),
                run_inference(io, &request(), "execution-1", Instant::now()),
            )
            .await
            .is_err()
        );
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn parses_structured_output_and_usage_without_echoing_input() {
        let (stdin, mut stdin_reader) = duplex(4096);
        let (mut stdout_writer, stdout) = duplex(4096);
        let (stderr_writer, stderr) = duplex(64);
        drop(stderr_writer);
        tokio::spawn(async move {
            let mut input = Vec::new();
            stdin_reader.read_to_end(&mut input).await.ok();
        });
        tokio::spawn(async move {
            let events = [
                json!({"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"last":{"inputTokens":12,"outputTokens":4,"totalTokens":16}}}}),
                json!({"method":"item/completed","params":{"item":{"type":"agentMessage","phase":"final_answer","text":"{\"create_objects\":[],\"create_connections\":[]}"}}}),
                json!({"method":"turn/completed","params":{"turn":{"status":"completed"}}}),
            ];
            for event in events {
                stdout_writer
                    .write_all(format!("{event}\n").as_bytes())
                    .await
                    .unwrap();
            }
        });
        let io = SandboxIoParts {
            stdin: Box::pin(stdin),
            stdout: Box::pin(stdout),
            stderr: Box::pin(stderr),
            guard: SandboxIoGuard::new(()),
            instance_id: None,
        };
        let response = run_inference(io, &request(), "execution-1", Instant::now())
            .await
            .unwrap();
        assert_eq!(response.output["create_objects"], json!([]));
        assert_eq!(response.usage.as_ref().unwrap()["inputTokens"], json!(12));
        assert_eq!(response.execution_id, "execution-1");
    }
}
