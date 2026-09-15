-- Run ONLY via the existing authorized collector against the same authoritative
-- MySQL WRITER and schema used by all pool replicas. Never a lagging read replica.
-- SELECT privilege on user_pool_settings only; no DDL, locks, owner UUID or secrets.
-- Configure the collector's connect + query TOTAL deadline <= 3000 ms; no retries.
-- MAX_EXECUTION_TIME is an extra MySQL bound, not a connection/client deadline.
-- Output aliases are the normalized numeric row contract consumed by monitor.mjs.
SELECT /*+ MAX_EXECUTION_TIME(2000) */
  COUNT(*) AS rowCount,
  (TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000) AS dbNowUnixMs,
  MAX(CASE WHEN owner IS NOT NULL THEN 1 ELSE 0 END) AS ownerPresent,
  MAX(owner_until) AS ownerUntilUnixMs,
  MAX(paused) AS paused
FROM user_pool_settings
WHERE id = 1;
