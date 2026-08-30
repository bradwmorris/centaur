use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use centaur_sandbox_core::SandboxSpec;
use centaur_session_runtime::SandboxRuntime;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::ApiError;

pub const CURATOR_MODEL: &str = "gpt-5.6-luna";
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

fn default_reasoning_effort() -> String {
    "low".to_owned()
}

impl CuratorInferenceRuntime {
    pub fn new(sandbox: SandboxRuntime, spec: SandboxSpec, timeout: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                sandbox,
                spec,
                timeout,
                cache: Mutex::new(IdempotencyCache::default()),
            }),
        }
    }

    pub async fn infer(
        &self,
        request: CuratorInferenceRequest,
    ) -> Result<CuratorInferenceResponse, ApiError> {
        validate_request(&request)?;
        let digest: [u8; 32] = Sha256::digest(
            serde_json::to_vec(&request)
                .map_err(|error| ApiError::BadRequest(error.to_string()))?,
        )
        .into();
        if let Some(cached) = self.cached_response(&request.request_id, &digest)? {
            return Ok(cached);
        }

        let started_at = Instant::now();
        let execution_id = uuid::Uuid::new_v4().to_string();
        let (sandbox_id, io) = self
            .inner
            .sandbox
            .create_running_io(self.inner.spec.clone())
            .await?;
        let result = tokio::time::timeout(
            self.inner.timeout,
            run_inference(io, &request, &execution_id, started_at),
        )
        .await;
        let stop_result = self.inner.sandbox.stop_sandbox(&sandbox_id).await;
        if let Err(error) = stop_result {
            tracing::warn!(sandbox_id = %sandbox_id.as_str(), %error, "failed to stop curator inference sandbox");
        }
        let response = match result {
            Ok(result) => result?,
            Err(_) => {
                return Err(ApiError::ServiceUnavailable(format!(
                    "curator inference timed out after {} seconds",
                    self.inner.timeout.as_secs()
                )));
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

fn validate_request(request: &CuratorInferenceRequest) -> Result<(), ApiError> {
    let request_id = request.request_id.trim();
    if request_id.is_empty() || request_id.len() > 128 {
        return Err(ApiError::BadRequest(
            "request_id must contain 1 to 128 characters".to_owned(),
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
    let expected_fields = [
        "create_connections",
        "create_objects",
        "update_connections",
        "update_objects",
    ];
    let mut required = request
        .output_schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    required.sort_unstable();
    let mut properties = request
        .output_schema
        .get("properties")
        .and_then(Value::as_object)
        .map(|properties| properties.keys().map(String::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    properties.sort_unstable();
    if required != expected_fields
        || properties != expected_fields
        || request.output_schema.get("additionalProperties") != Some(&Value::Bool(false))
    {
        return Err(ApiError::BadRequest(
            "output_schema must be the dedicated four-array Curator plan contract".to_owned(),
        ));
    }
    if !matches!(
        request.reasoning_effort.as_str(),
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    ) {
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
    } = io;
    let stderr_task = tokio::spawn(async move {
        let stderr = BufReader::new(stderr);
        let mut sink = Vec::new();
        let _ = stderr
            .take(MAX_OUTPUT_BYTES as u64)
            .read_to_end(&mut sink)
            .await;
        sink.len()
    });
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

    let mut lines = BufReader::new(stdout).lines();
    let mut answer = String::new();
    let mut observed_usage = None;
    let usage = loop {
        let Some(line) = lines
            .next_line()
            .await
            .map_err(|error| ApiError::Internal(format!("read curator sandbox output: {error}")))?
        else {
            return Err(ApiError::ServiceUnavailable(
                "curator sandbox ended before turn completion".to_owned(),
            ));
        };
        if line.len() > MAX_OUTPUT_BYTES || answer.len() > MAX_OUTPUT_BYTES {
            return Err(ApiError::PayloadTooLarge(
                "curator model output exceeded its byte limit".to_owned(),
            ));
        }
        let event: Value = serde_json::from_str(&line).map_err(|_| {
            ApiError::ServiceUnavailable("curator sandbox emitted malformed output".to_owned())
        })?;
        if contains_tool_activity(&event) {
            return Err(ApiError::ServiceUnavailable(
                "curator inference attempted prohibited tool activity".to_owned(),
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
        if method == Some("turn/completed") {
            let usage = event
                .pointer("/params/turn/usage")
                .or_else(|| event.pointer("/params/usage"))
                .cloned()
                .or(observed_usage);
            break usage;
        }
        if matches!(method, Some("turn/failed" | "error")) {
            return Err(ApiError::ServiceUnavailable(
                "curator model turn failed".to_owned(),
            ));
        }
    };
    stderr_task.abort();
    let output = serde_json::from_str(answer.trim()).map_err(|_| {
        ApiError::ServiceUnavailable("curator model returned invalid JSON".to_owned())
    })?;
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
}

fn contains_tool_activity(value: &Value) -> bool {
    ["/params/item/type", "/item/type"]
        .into_iter()
        .filter_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .any(|kind| {
            matches!(
                kind,
                "commandExecution" | "command_execution" | "mcpToolCall" | "mcp_tool_call"
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
            system_prompt: "curate".to_owned(),
            input: "evidence".to_owned(),
            output_schema: json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["create_objects", "update_objects", "create_connections", "update_connections"],
                "properties": {
                    "create_objects": {}, "update_objects": {},
                    "create_connections": {}, "update_connections": {}
                }
            }),
            reasoning_effort: "low".to_owned(),
        }
    }

    #[test]
    fn validates_bounds_and_reasoning() {
        assert!(validate_request(&request()).is_ok());
        let mut invalid = request();
        invalid.reasoning_effort = "ultra".to_owned();
        assert!(matches!(
            validate_request(&invalid),
            Err(ApiError::BadRequest(_))
        ));
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
        };
        assert!(matches!(
            run_inference(io, &request(), "execution-1", Instant::now()).await,
            Err(ApiError::ServiceUnavailable(_))
        ));
    }

    #[tokio::test]
    async fn caller_timeout_can_cancel_a_hung_inference() {
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
            guard: SandboxIoGuard::new(()),
        };
        assert!(
            tokio::time::timeout(
                Duration::from_millis(10),
                run_inference(io, &request(), "execution-1", Instant::now()),
            )
            .await
            .is_err()
        );
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
                json!({"method":"item/completed","params":{"item":{"type":"agentMessage","phase":"final_answer","text":"{\"create_objects\":[],\"update_objects\":[],\"create_connections\":[],\"update_connections\":[]}"}}}),
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
        };
        let response = run_inference(io, &request(), "execution-1", Instant::now())
            .await
            .unwrap();
        assert_eq!(response.output["create_objects"], json!([]));
        assert_eq!(response.usage.as_ref().unwrap()["inputTokens"], json!(12));
        assert_eq!(response.execution_id, "execution-1");
    }
}
