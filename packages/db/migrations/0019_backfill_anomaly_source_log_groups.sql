-- Transaction anomalies predate the sourceLogGroups result field. Their
-- lifecycle agent already stores the exact CloudWatch log group, so copy it
-- into anomaly metadata for immediate display on existing Recent Anomalies.
UPDATE anomalies AS anomaly
SET metadata = COALESCE(anomaly.metadata, '{}'::jsonb)
  || jsonb_build_object('sourceLogGroups', jsonb_build_array(agent.log_group))
FROM agents AS agent
WHERE anomaly.fingerprint = 'tx:' || agent.message_id
  AND agent.log_group IS NOT NULL
  AND btrim(agent.log_group) <> ''
  AND COALESCE(anomaly.metadata->'sourceLogGroups', '[]'::jsonb) = '[]'::jsonb;
