CREATE TABLE fund (
    id UUID PRIMARY KEY, name TEXT NOT NULL, administrator TEXT NOT NULL, strategy TEXT NOT NULL,
    currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR', 'GBP'))
);
CREATE TABLE reconciliation_period (
    id UUID PRIMARY KEY, fund_id UUID NOT NULL REFERENCES fund(id),
    period_start DATE NOT NULL, period_end DATE NOT NULL,
    entity_scope TEXT NOT NULL CHECK (entity_scope = 'fund'),
    currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR', 'GBP')),
    ruleset_version TEXT NOT NULL, tolerance NUMERIC(38,6) NOT NULL CHECK (tolerance >= 0),
    current_pack_id UUID, CHECK (period_start <= period_end),
    UNIQUE (fund_id, period_start, period_end, entity_scope)
);
CREATE TABLE pack (
    id UUID PRIMARY KEY, reconciliation_period_id UUID NOT NULL REFERENCES reconciliation_period(id),
    version INTEGER NOT NULL CHECK (version > 0), state TEXT NOT NULL CHECK (state IN ('ready', 'needs_input', 'failed')),
    manifest_sha256 TEXT NOT NULL, UNIQUE (reconciliation_period_id, version),
    UNIQUE (id, reconciliation_period_id)
);
ALTER TABLE reconciliation_period ADD CONSTRAINT selected_pack_belongs_to_period
    FOREIGN KEY (current_pack_id, id) REFERENCES pack(id, reconciliation_period_id);
CREATE TABLE document (
    id UUID PRIMARY KEY, pack_id UUID NOT NULL REFERENCES pack(id), filename TEXT NOT NULL,
    storage_key TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
    media_type TEXT NOT NULL, role TEXT NOT NULL, UNIQUE (pack_id, filename)
);
CREATE TABLE reconciliation_run (
    sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
    id UUID PRIMARY KEY, reconciliation_period_id UUID NOT NULL REFERENCES reconciliation_period(id),
    pack_id UUID NOT NULL, input_snapshot JSONB NOT NULL,
    requested_by TEXT NOT NULL, request_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed')),
    stage TEXT NOT NULL, outcome TEXT CHECK (outcome IN ('matched','mismatch','insufficient_evidence')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    stage_updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), completed_at TIMESTAMPTZ,
    reported_nav NUMERIC(38,6), calculated_nav NUMERIC(38,6), difference NUMERIC(38,6),
    result JSONB, error JSONB,
    FOREIGN KEY (pack_id, reconciliation_period_id) REFERENCES pack(id, reconciliation_period_id),
    CHECK ((state = 'completed') = (outcome IS NOT NULL)),
    CHECK ((state = 'completed') = (result IS NOT NULL)),
    CHECK ((state = 'failed') = (error IS NOT NULL)),
    CHECK ((state IN ('completed','failed')) = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_run_per_period ON reconciliation_run(reconciliation_period_id)
    WHERE state IN ('queued','running');
CREATE INDEX runs_by_period ON reconciliation_run(reconciliation_period_id, sequence DESC);
CREATE TABLE extracted_fact (
    id UUID PRIMARY KEY, run_id UUID NOT NULL REFERENCES reconciliation_run(id),
    document_id UUID NOT NULL REFERENCES document(id), field TEXT NOT NULL,
    raw_text TEXT NOT NULL, amount NUMERIC(38,6) NOT NULL, currency TEXT NOT NULL, scale TEXT NOT NULL,
    locator JSONB NOT NULL, normalisation_steps JSONB NOT NULL,
    UNIQUE (run_id, field)
);
CREATE TABLE check_result (
    id UUID PRIMARY KEY, run_id UUID NOT NULL REFERENCES reconciliation_run(id), check_type TEXT NOT NULL,
    required BOOLEAN NOT NULL, status TEXT NOT NULL CHECK (status IN ('pass','fail','not_evaluated')),
    reason_code TEXT, expected_amount NUMERIC(38,6), reported_amount NUMERIC(38,6),
    difference_amount NUMERIC(38,6), tolerance_amount NUMERIC(38,6), currency TEXT,
    input_fact_ids JSONB NOT NULL, UNIQUE(run_id, check_type)
);
CREATE TABLE idempotency_record (
    actor_id TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL,
    request_hash TEXT NOT NULL, run_id UUID NOT NULL REFERENCES reconciliation_run(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (actor_id, operation, key)
);
