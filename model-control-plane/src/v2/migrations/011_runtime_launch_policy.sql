CREATE TABLE IF NOT EXISTS v2_runtime_launch_decisions (
  id TEXT PRIMARY KEY,
  runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('OPENCODE','CODEX')),
  policy_mode TEXT NOT NULL CHECK (policy_mode IN ('OBSERVE','PREFER','ENFORCE')),
  status TEXT NOT NULL CHECK (status IN ('SELECTED','EXPLICIT_OVERRIDE','UNRESOLVED','BLOCKED')),
  position_id TEXT REFERENCES v2_positions(id),
  employee_id TEXT REFERENCES v2_employees(id),
  employment_id TEXT REFERENCES v2_employments(id),
  model_offering_id TEXT REFERENCES v2_model_offerings(id),
  appointment_id TEXT REFERENCES v2_appointments(id),
  session_id TEXT,
  task_id TEXT,
  tool_call_id TEXT,
  work_scope_hint TEXT,
  position_hint TEXT,
  workdir_hint TEXT,
  requested_model TEXT,
  selected_model TEXT,
  selected_profile TEXT,
  command_name TEXT,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  candidate_results_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  decided_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS v2_runtime_launch_tool_call
  ON v2_runtime_launch_decisions(tool_call_id)
  WHERE tool_call_id IS NOT NULL AND tool_call_id <> '';

CREATE INDEX IF NOT EXISTS v2_runtime_launch_recent
  ON v2_runtime_launch_decisions(decided_at DESC);

CREATE INDEX IF NOT EXISTS v2_runtime_launch_employee
  ON v2_runtime_launch_decisions(employee_id, decided_at DESC);
