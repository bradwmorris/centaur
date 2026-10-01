-- Admission is committed before enqueue; a retry can safely finish an interrupted enqueue.
CREATE TABLE external_workflow_requests (
    caller_id text NOT NULL,
    request_id text NOT NULL,
    request_digest text NOT NULL,
    workflow_name text NOT NULL,
    run_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (caller_id, request_id)
);

CREATE TABLE external_workflow_children (
    caller_id text NOT NULL,
    request_id text NOT NULL,
    task_id text NOT NULL,
    run_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (caller_id, request_id, task_id),
    FOREIGN KEY (caller_id, request_id) REFERENCES external_workflow_requests ON DELETE CASCADE
);
