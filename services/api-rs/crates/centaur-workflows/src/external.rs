//! External-agent admission. Postgres owns request identity and retry recovery.
use super::*;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WorkflowDescriptor {
    pub workflow_name: String,
    pub description: String,
    pub input_schema: Option<Value>,
    pub input_contract: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalRequest {
    pub request_id: String,
    pub workflow_name: String,
    pub thread_id: String,
    pub input: Value,
}
fn bounded_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}
impl ExternalRequest {
    pub fn validate(&self) -> Result<(), WorkflowRuntimeError> {
        if !bounded_id(&self.request_id)
            || !bounded_id(&self.thread_id)
            || !bounded_id(&self.workflow_name)
            || !self.input.is_object()
            || self.input.get("_centaur_external").is_some()
        {
            return Err(WorkflowRuntimeError::BadRequest("bounded request_id, thread_id, workflow_name and object input without reserved provenance are required".into()));
        }
        Ok(())
    }
    fn digest(&self) -> Result<String, WorkflowRuntimeError> {
        Ok(digest_hex(&serde_json::to_vec(self)?))
    }
}
fn digest_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn admission_key(caller: &str, request_id: &str) -> String {
    format!(
        "external:{}",
        digest_hex(&serde_json::to_vec(&(caller, request_id)).expect("strings serialize"))
    )
}
async fn reserve(
    pool: &sqlx::PgPool,
    caller: &str,
    request: &ExternalRequest,
) -> Result<Option<String>, WorkflowRuntimeError> {
    let digest = request.digest()?;
    // Commit the digest before spawn; retries repair an interrupted enqueue.
    sqlx::query("INSERT INTO external_workflow_requests (caller_id,request_id,request_digest,workflow_name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING")
        .bind(caller).bind(&request.request_id).bind(&digest).bind(&request.workflow_name).execute(pool).await?;
    let row = sqlx::query("SELECT request_digest,run_id FROM external_workflow_requests WHERE caller_id=$1 AND request_id=$2")
        .bind(caller).bind(&request.request_id).fetch_one(pool).await?;
    if row.try_get::<String, _>("request_digest")? != digest {
        return Err(WorkflowRuntimeError::BadRequest(
            "request_id already used with different input, workflow or thread".into(),
        ));
    }
    Ok(row.try_get("run_id")?)
}
impl WorkflowRuntime {
    pub fn external_catalog(&self) -> Result<Vec<WorkflowDescriptor>, WorkflowRuntimeError> {
        let enablement = WorkflowEnablement::from_env()?;
        Ok(self
            .inner
            .external_catalog
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .filter(|i| enablement.is_enabled(&i.workflow_name))
            .cloned()
            .collect())
    }
    pub fn validate_external(&self, request: &ExternalRequest) -> Result<(), WorkflowRuntimeError> {
        request.validate()?;
        if !self
            .external_catalog()?
            .iter()
            .any(|i| i.workflow_name == request.workflow_name)
        {
            return Err(WorkflowRuntimeError::BadRequest(
                "workflow is not in the enabled catalog".into(),
            ));
        }
        Ok(())
    }
    pub async fn start_external(
        &self,
        caller: &str,
        request: ExternalRequest,
    ) -> Result<Value, WorkflowRuntimeError> {
        self.validate_external(&request)?;
        if reserve(&self.inner.pool, caller, &request).await?.is_none() {
            let external_origin = json!({"caller_id":caller,"thread_id":request.thread_id,"request_id":request.request_id});
            let run = self
                .create_run_with_origin(
                    CreateWorkflowRunRequest {
                        workflow_name: request.workflow_name,
                        input: request.input,
                        idempotency_key: Some(admission_key(caller, &request.request_id)),
                        harness_type: None,
                        max_attempts: None,
                    },
                    None,
                    Some(external_origin),
                )
                .await?;
            sqlx::query("UPDATE external_workflow_requests SET run_id=COALESCE(run_id,$3) WHERE caller_id=$1 AND request_id=$2")
                .bind(caller).bind(&request.request_id).bind(run.run_id).execute(&self.inner.pool).await?;
        }
        self.external_status(caller, &request.request_id).await
    }
    async fn external_current_run(
        &self,
        original_run_id: &str,
    ) -> Result<WorkflowRun, WorkflowRuntimeError> {
        for queue in [
            WORKFLOW_QUEUE,
            WORKFLOW_SLACK_LIVE_QUEUE,
            WORKFLOW_ETL_QUEUE,
            WORKFLOW_ETL_BACKFILL_QUEUE,
        ] {
            let (tasks, runs) = absurd_queue_tables(queue)?;
            let current: Option<String> = sqlx::query_scalar(&format!(
                "SELECT t.last_attempt_run::text FROM {tasks} t JOIN {runs} r ON r.task_id=t.task_id WHERE r.run_id=$1::uuid"))
                .bind(original_run_id).fetch_optional(&self.inner.pool).await?;
            if let Some(id) = current {
                return self
                    .get_run_for_queue(queue, &id)
                    .await?
                    .ok_or(WorkflowRuntimeError::NotFound(id));
            }
        }
        Err(WorkflowRuntimeError::NotFound(original_run_id.into()))
    }
    pub async fn external_status(
        &self,
        caller: &str,
        request_id: &str,
    ) -> Result<Value, WorkflowRuntimeError> {
        if !bounded_id(request_id) {
            return Err(WorkflowRuntimeError::BadRequest(
                "invalid request_id".into(),
            ));
        }
        let row = sqlx::query("SELECT run_id,workflow_name FROM external_workflow_requests WHERE caller_id=$1 AND request_id=$2")
            .bind(caller).bind(request_id).fetch_optional(&self.inner.pool).await?.ok_or_else(||WorkflowRuntimeError::NotFound("external request".into()))?;
        let workflow_name: String = row.try_get("workflow_name")?;
        let Some(run_id) = row.try_get::<Option<String>, _>("run_id")? else {
            return Ok(
                json!({"request_id":request_id,"workflow_name":workflow_name,"status":"admitted","resume":"resubmit identical request to finish admission"}),
            );
        };
        let run = self.external_current_run(&run_id).await?;
        let rows = sqlx::query("SELECT run_id FROM external_workflow_children WHERE caller_id=$1 AND request_id=$2 ORDER BY created_at,task_id LIMIT 51")
            .bind(caller).bind(request_id).fetch_all(&self.inner.pool).await?;
        let truncated = rows.len() > 50;
        let mut children = Vec::new();
        for row in rows.into_iter().take(50) {
            let child_id: String = row.try_get("run_id")?;
            let child = self.external_current_run(&child_id).await?;
            children.push(json!({"workflow_name":child.workflow_name,"run_id":child.run_id,"task_id":child.task_id,"status":child.status,"result":child.result,"failure":child.failure}));
        }

        let approvals = sqlx::query("SELECT approval_id,event_name,preview_digest,descriptor,decision FROM workflow_approvals WHERE caller_id=$1 AND request_id=$2 ORDER BY created_at")
            .bind(caller).bind(request_id).fetch_all(&self.inner.pool).await?
            .into_iter().map(|r| Ok(json!({"approval_id":r.try_get::<String,_>("approval_id")?,"event_name":r.try_get::<String,_>("event_name")?,"preview_digest":r.try_get::<String,_>("preview_digest")?,"descriptor":r.try_get::<Value,_>("descriptor")?,"decision":r.try_get::<Option<Value>,_>("decision")?})))
            .collect::<Result<Vec<Value>,sqlx::Error>>()?;
        Ok(
            json!({"approvals":approvals,"request_id":request_id,"workflow_name":workflow_name,"run_id":run.run_id,"task_id":run.task_id,"status":run.status,"attempts":run.attempts,"result":run.result,"failure":run.failure,"children":children,"children_truncated":truncated}),
        )
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalDecision {
    pub approval_id: String,
    pub preview_digest: String,
    pub decision: String,
    pub thread_id: String,
    pub approval_reference: String,
}
fn approval_error(message: &str) -> WorkflowRuntimeError {
    WorkflowRuntimeError::BadRequest(message.into())
}
fn validate_descriptor(value: &Value) -> Result<(), WorkflowRuntimeError> {
    let exact = value
        .get("exact")
        .and_then(Value::as_object)
        .ok_or_else(|| approval_error("approval requires exact fields"))?;
    if !value.get("preview").is_some_and(Value::is_object)
        || [
            "actor",
            "decision",
            "verified",
            "signed_at",
            "approval_reference",
            "thread_id",
        ]
        .iter()
        .any(|k| exact.contains_key(*k))
        || serde_json::to_vec(value)?.len() > 500_000
    {
        return Err(approval_error("invalid approval descriptor"));
    }
    for field in ["approvers", "decisions"] {
        let items = value
            .get(field)
            .and_then(Value::as_array)
            .ok_or_else(|| approval_error("approval requires approvers and decisions"))?;
        if items.is_empty()
            || items.len() > 20
            || items.iter().any(|i| !i.as_str().is_some_and(bounded_id))
        {
            return Err(approval_error("invalid approval choices"));
        }
    }
    Ok(())
}
pub(super) async fn register_approval(
    pool: &sqlx::PgPool,
    owner: &Value,
    task_id: &str,
    step: &str,
    event_name: &str,
    descriptor: &Value,
) -> Result<(), WorkflowRuntimeError> {
    validate_descriptor(descriptor)?;
    let approval_id = digest_hex(&serde_json::to_vec(&(task_id, step))?);
    let digest = digest_hex(&serde_json::to_vec(descriptor)?);
    sqlx::query("INSERT INTO workflow_approvals (approval_id,caller_id,request_id,task_id,event_name,descriptor,preview_digest) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (approval_id) DO NOTHING")
        .bind(&approval_id).bind(owner["caller_id"].as_str()).bind(owner["request_id"].as_str())
        .bind(task_id).bind(event_name).bind(descriptor).bind(&digest).execute(pool).await?;
    let row = sqlx::query("SELECT preview_digest,event_name,caller_id,request_id FROM workflow_approvals WHERE approval_id=$1")
        .bind(&approval_id).fetch_one(pool).await?;
    if row.try_get::<String, _>("preview_digest")? != digest
        || row.try_get::<String, _>("event_name")? != event_name
        || Some(row.try_get::<String, _>("caller_id")?.as_str()) != owner["caller_id"].as_str()
        || Some(row.try_get::<String, _>("request_id")?.as_str()) != owner["request_id"].as_str()
    {
        return Err(approval_error(
            "approval step changed its saved preview or owner",
        ));
    }
    Ok(())
}
fn validate_decision(descriptor: &Value, payload: &Value) -> Result<(), WorkflowRuntimeError> {
    if payload.get("verified") != Some(&Value::Bool(true))
        || !payload
            .get("signed_at")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
        || !descriptor["approvers"]
            .as_array()
            .is_some_and(|v| v.contains(&payload["actor"]))
        || !descriptor["decisions"]
            .as_array()
            .is_some_and(|v| v.contains(&payload["decision"]))
        || !descriptor["exact"]
            .as_object()
            .is_some_and(|v| v.iter().all(|(k, value)| payload.get(k) == Some(value)))
    {
        return Err(approval_error("decision does not match the saved approval"));
    }
    Ok(())
}
// Trusted event ingress and desktop decisions converge here. The first persisted
// payload wins. Identical semantic retries reuse its original timestamp/audit.
pub(super) async fn record_event_decision(
    pool: &sqlx::PgPool,
    event_name: &str,
    value: Value,
) -> Result<Value, WorkflowRuntimeError> {
    let mut tx = pool.begin().await?;
    let Some(row) = sqlx::query("SELECT approval_id,descriptor,decision FROM workflow_approvals WHERE event_name=$1 FOR UPDATE")
        .bind(event_name).fetch_optional(&mut *tx).await? else { return Ok(value); };
    let payload = value.get("payload").unwrap_or(&value);
    let descriptor: Value = row.try_get("descriptor")?;
    validate_decision(&descriptor, payload)?;
    if let Some(saved) = row.try_get::<Option<Value>, _>("decision")? {
        if saved["decision"] != payload["decision"] || saved["actor"] != payload["actor"] {
            return Err(approval_error("approval already decided"));
        }
        tx.commit().await?;
        return Ok(saved);
    }
    let id: String = row.try_get("approval_id")?;
    sqlx::query("UPDATE workflow_approvals SET decision=$2,decided_at=now() WHERE approval_id=$1")
        .bind(id)
        .bind(payload)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(payload.clone())
}
impl WorkflowRuntime {
    pub async fn decide_external(
        &self,
        caller: &str,
        request_id: &str,
        request: ApprovalDecision,
    ) -> Result<Value, WorkflowRuntimeError> {
        if !bounded_id(request_id)
            || !bounded_id(&request.approval_id)
            || !bounded_id(&request.thread_id)
            || request.approval_reference.trim().is_empty()
            || request.approval_reference.len() > 2000
        {
            return Err(approval_error(
                "approval requires saved identity and a human approval reference",
            ));
        }
        // Explicit operator delegation, separate from permission to start/read.
        // The agent must obtain human approval; this is not a signed chat proof.
        let config =
            std::env::var("CENTAUR_EXTERNAL_WORKFLOW_APPROVERS").unwrap_or_else(|_| "{}".into());
        let actors: BTreeMap<String, String> = serde_json::from_str(&config)
            .map_err(|_| approval_error("invalid external approver configuration"))?;
        let actor = caller
            .strip_prefix("external:")
            .and_then(|name| actors.get(name))
            .filter(|actor| bounded_id(actor))
            .ok_or_else(|| approval_error("caller has no delegated approval grant"))?;
        let row = sqlx::query("SELECT event_name,descriptor,preview_digest FROM workflow_approvals WHERE approval_id=$1 AND caller_id=$2 AND request_id=$3")
            .bind(&request.approval_id).bind(caller).bind(request_id).fetch_optional(&self.inner.pool).await?
            .ok_or_else(||WorkflowRuntimeError::NotFound("approval".into()))?;
        if row.try_get::<String, _>("preview_digest")? != request.preview_digest {
            return Err(approval_error("approval preview digest mismatch"));
        }
        let descriptor: Value = row.try_get("descriptor")?;
        let mut payload = descriptor["exact"].clone();
        let object = payload
            .as_object_mut()
            .ok_or_else(|| approval_error("invalid saved approval"))?;
        object.extend(serde_json::from_value::<serde_json::Map<String,Value>>(json!({
            "actor":actor,"decision":request.decision,"verified":true,
            "signed_at":chrono::Utc::now().to_rfc3339(),"thread_id":request.thread_id,
            "approval_reference":request.approval_reference,"approval_surface":"delegated_desktop"
        }))?);
        let event_name: String = row.try_get("event_name")?;
        self.emit_event(&event_name, payload).await?;
        self.external_status(caller, request_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(input: Value) -> ExternalRequest {
        ExternalRequest {
            request_id: "req-1".into(),
            workflow_name: "echo".into(),
            thread_id: "thread-1".into(),
            input,
        }
    }
    #[test]
    fn identity_binds_content_and_thread_not_key_order() {
        let a = request(json!({"a":1,"b":{"x":2,"y":3}}));
        let b = request(json!({"b":{"y":3,"x":2},"a":1}));
        assert_eq!(a.digest().unwrap(), b.digest().unwrap());
        let mut c = b;
        c.thread_id = "another".into();
        assert_ne!(a.digest().unwrap(), c.digest().unwrap());
        assert_ne!(
            a.digest().unwrap(),
            request(json!({"a":2})).digest().unwrap()
        );
        assert_ne!(admission_key("alice", "x"), admission_key("bob", "x"));
    }
    #[test]
    fn rejects_forged_provenance_and_path_inputs() {
        assert!(request(json!({"_centaur_external":{}})).validate().is_err());
        assert!(request(json!([])).validate().is_err());
        let mut r = request(json!({}));
        r.request_id = "../../other".into();
        assert!(r.validate().is_err());
    }
    #[tokio::test]
    async fn durable_reservation_rejects_conflicts_and_isolates_callers() {
        let Ok(url) = std::env::var("SESSION_RUNTIME_TEST_DATABASE_URL") else {
            eprintln!("SKIP: disposable database not configured");
            return;
        };
        let pool = sqlx::PgPool::connect(&url).await.unwrap();
        let caller = format!("external-test-{}", uuid::Uuid::new_v4());
        let mut r = request(json!({"message":"one"}));
        assert!(reserve(&pool, &caller, &r).await.unwrap().is_none());
        assert!(reserve(&pool, &caller, &r).await.unwrap().is_none());
        r.input = json!({"message":"changed"});
        assert!(reserve(&pool, &caller, &r).await.is_err());
        let other = format!("{caller}-other");
        assert!(reserve(&pool, &other, &r).await.unwrap().is_none());
        sqlx::query("DELETE FROM external_workflow_requests WHERE caller_id=ANY($1)")
            .bind(vec![caller, other])
            .execute(&pool)
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn lost_enqueue_response_reuses_durable_task() {
        let Ok(url) = std::env::var("SESSION_RUNTIME_TEST_DATABASE_URL") else {
            return;
        };
        let pool = sqlx::PgPool::connect(&url).await.unwrap();
        let queue = format!("external_test_{}", uuid::Uuid::new_v4().simple());
        let client = Client::from_pool_with_options(
            pool.clone(),
            ClientOptions {
                queue_name: queue.clone(),
                ..ClientOptions::default()
            },
        )
        .unwrap();
        client
            .create_queue(None, CreateQueueOptions::default())
            .await
            .unwrap();
        client
            .register_task("synthetic", |value: Value, _ctx| async move { Ok(value) })
            .unwrap();
        let caller = format!("external-test-{}", uuid::Uuid::new_v4());
        let request = request(json!({"message": "synthetic"}));
        reserve(&pool, &caller, &request).await.unwrap();
        let first = client
            .spawn(
                "synthetic",
                &request.input,
                SpawnOptions {
                    idempotency_key: Some(admission_key(&caller, &request.request_id)),
                    ..SpawnOptions::default()
                },
            )
            .await
            .unwrap();
        // Simulate response loss before admission row receives run_id.
        assert!(reserve(&pool, &caller, &request).await.unwrap().is_none());
        let retry = client
            .spawn(
                "synthetic",
                &request.input,
                SpawnOptions {
                    idempotency_key: Some(admission_key(&caller, &request.request_id)),
                    ..SpawnOptions::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(first.task_id, retry.task_id);
        assert!(!retry.created);
        sqlx::query("DELETE FROM external_workflow_requests WHERE caller_id=$1")
            .bind(caller)
            .execute(&pool)
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn approval_is_immutable_and_first_decision_survives_retry() {
        let Ok(url) = std::env::var("SESSION_RUNTIME_TEST_DATABASE_URL") else {
            return;
        };
        let pool = sqlx::PgPool::connect(&url).await.unwrap();
        let caller = format!("external-test-{}", uuid::Uuid::new_v4());
        let task = uuid::Uuid::new_v4().to_string();
        reserve(&pool, &caller, &request(json!({}))).await.unwrap();
        let owner = json!({"caller_id":caller,"request_id":"req-1"});
        let descriptor = json!({"preview":{"subject":"Synthetic","body":"Reviewed message"},"exact":{"run_id":task,"content_hash":"one"},"approvers":["human"],"decisions":["approve","reject"]});
        let event = format!("approval:{task}");
        register_approval(&pool, &owner, &task, "send", &event, &descriptor)
            .await
            .unwrap();
        register_approval(&pool, &owner, &task, "send", &event, &descriptor)
            .await
            .unwrap();
        let mut changed = descriptor.clone();
        changed["preview"]["body"] = json!("Different message");
        assert!(
            register_approval(&pool, &owner, &task, "send", &event, &changed)
                .await
                .is_err()
        );
        let payload = json!({"actor":"human","decision":"approve","verified":true,"signed_at":"first","run_id":task,"content_hash":"one"});
        for (field, value) in [
            ("actor", json!("other")),
            ("verified", json!(false)),
            ("content_hash", json!("other")),
            ("decision", json!("send-anything")),
        ] {
            let mut invalid = payload.clone();
            invalid[field] = value;
            assert!(record_event_decision(&pool, &event, invalid).await.is_err());
        }
        let mut rejection = payload.clone();
        rejection["decision"] = json!("reject");
        let (first, second) = tokio::join!(
            record_event_decision(&pool, &event, payload.clone()),
            record_event_decision(&pool, &event, rejection)
        );
        assert_ne!(first.is_ok(), second.is_ok());
        let saved = first.or(second).unwrap();
        let mut retry = saved.clone();
        retry["signed_at"] = json!("later");
        // A retry after process restart/event-delivery loss returns original audit.
        assert_eq!(
            record_event_decision(&pool, &event, retry).await.unwrap(),
            saved
        );
        let mut opposite = saved.clone();
        opposite["decision"] = if saved["decision"] == "approve" {
            json!("reject")
        } else {
            json!("approve")
        };
        assert!(
            record_event_decision(&pool, &event, opposite)
                .await
                .is_err()
        );
        sqlx::query("DELETE FROM external_workflow_requests WHERE caller_id=$1")
            .bind(caller)
            .execute(&pool)
            .await
            .unwrap();
    }
    #[test]
    fn workflow_cannot_set_approval_actor_or_bypass_choices() {
        let mut descriptor =
            json!({"preview":{},"exact":{},"approvers":["human"],"decisions":["approve"]});
        validate_descriptor(&descriptor).unwrap();
        descriptor["exact"]["actor"] = json!("human");
        assert!(validate_descriptor(&descriptor).is_err());
    }
    #[tokio::test]
    async fn deduplicated_child_results_stay_with_the_original_caller() {
        let Ok(url) = std::env::var("SESSION_RUNTIME_TEST_DATABASE_URL") else {
            return;
        };
        let pool = sqlx::PgPool::connect(&url).await.unwrap();
        let client = Client::from_pool_with_options(
            pool.clone(),
            ClientOptions {
                queue_name: WORKFLOW_QUEUE.into(),
                ..ClientOptions::default()
            },
        )
        .unwrap();
        client
            .create_queue(None, CreateQueueOptions::default())
            .await
            .unwrap();
        client
            .register_task(WORKFLOW_TASK, |value: Value, _ctx| async move { Ok(value) })
            .unwrap();
        let clients = WorkflowQueueClients {
            standard: client.clone(),
            slack_live: client.clone(),
            etl: client.clone(),
            etl_backfill: client,
        };
        let alice = format!("external-test-{}", uuid::Uuid::new_v4());
        let bob = format!("{alice}-other");
        for caller in [&alice, &bob] {
            reserve(&pool, caller, &request(json!({}))).await.unwrap();
        }
        let mut parent = WorkflowTaskInput {
            external_origin: None,
            external_owner: Some(json!({"caller_id":alice,"request_id":"req-1"})),
            workflow_name: "echo".into(),
            input: json!({}),
            harness_type: HarnessType::Codex,
            slack_button_feedback: None,
        };
        let message = json!({"workflow_name":"echo","input":{"message":"synthetic"},"idempotency_key":uuid::Uuid::new_v4().to_string()});
        let first = start_python_child_workflow(&message, &parent, &clients)
            .await
            .unwrap();
        let retry = start_python_child_workflow(&message, &parent, &clients)
            .await
            .unwrap();
        assert_eq!(first["task_id"], retry["task_id"]);
        parent.external_owner = Some(json!({"caller_id":bob,"request_id":"req-1"}));
        assert!(
            start_python_child_workflow(&message, &parent, &clients)
                .await
                .is_err()
        );
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM external_workflow_children WHERE caller_id=$1",
        )
        .bind(&bob)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 0);
        sqlx::query("DELETE FROM external_workflow_requests WHERE caller_id=ANY($1)")
            .bind(vec![alice, bob])
            .execute(&pool)
            .await
            .unwrap();
    }
}
