export function readInferenceTimeoutMs(env: NodeJS.ProcessEnv, enabled: boolean): number | undefined {
  if (!enabled || env.POOL_INFERENCE_TIMEOUT_SECONDS === undefined) return undefined;
  const raw = env.POOL_INFERENCE_TIMEOUT_SECONDS;
  const seconds = Number(raw);
  if (!/^\d+$/.test(raw) || raw.trim() !== raw || !Number.isSafeInteger(seconds) || seconds < 5 || seconds > 600) {
    throw new Error('Invalid POOL_INFERENCE_TIMEOUT_SECONDS');
  }
  return seconds * 1000;
}

export function inferenceHoldTimeoutMs(override: number | undefined, fallback: number): number {
  if (override === undefined) return fallback;
  if (!Number.isSafeInteger(override) || override < 5000 || override > 600000) {
    throw new Error('Invalid inference hold timeout');
  }
  return override;
}
