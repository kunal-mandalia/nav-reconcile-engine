-- The frozen policy lives in input_snapshot; bounded diagnostic outputs survive
-- failed runs without becoming published financial facts. No credentials/images.
ALTER TABLE reconciliation_run ADD COLUMN agent_trace JSONB;
