const metricsStore = {
  actionCount: 0,
  errorCount: 0,
  totalLatencyMs: 0,
};

export function recordActionMetric(durationMs: number, isError: boolean): void {
  metricsStore.actionCount++;
  metricsStore.totalLatencyMs += durationMs;
  if (isError) metricsStore.errorCount++;
}

export function getMetrics() {
  return {
    actions_total: metricsStore.actionCount,
    errors_total: metricsStore.errorCount,
    avg_latency_ms: metricsStore.actionCount > 0
      ? Math.round(metricsStore.totalLatencyMs / metricsStore.actionCount)
      : 0,
  };
}

export function resetMetrics(): void {
  metricsStore.actionCount = 0;
  metricsStore.errorCount = 0;
  metricsStore.totalLatencyMs = 0;
}
