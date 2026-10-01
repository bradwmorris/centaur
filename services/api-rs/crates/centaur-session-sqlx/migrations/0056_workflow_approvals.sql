-- Immutable, caller-scoped approval previews; a first decision wins across ingress surfaces.
CREATE TABLE workflow_approvals (
    approval_id text PRIMARY KEY,
    caller_id text NOT NULL,
    request_id text NOT NULL,
    task_id text NOT NULL,
    event_name text NOT NULL UNIQUE,
    descriptor jsonb NOT NULL,
    preview_digest text NOT NULL,
    decision jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz,
    FOREIGN KEY (caller_id,request_id) REFERENCES external_workflow_requests ON DELETE CASCADE
);
CREATE INDEX workflow_approvals_owner ON workflow_approvals(caller_id,request_id);
