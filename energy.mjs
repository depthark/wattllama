// Energy arithmetic shared by the server and its tests. Pure functions, no I/O.

/** Wh above the idle baseline for `activeS` busy seconds; null while the baseline is unknown. */
export const aboveIdle = (wh, activeS, idleW) => idleW == null ? null : Math.max(0, wh - idleW * activeS / 3600);

/** Wh per 1,000 tokens; null without tokens or energy. */
export const per1k = (wh, tokens) => wh != null && tokens > 0 ? wh / (tokens / 1000) : null;

/**
 * Split a model's busy energy into prefill and generation by the time each took in its logged
 * requests (an estimate: both phases are assumed to draw the same power). The token counts are
 * the model's own (table mm), not the requests table's, which keeps only 90 days and so would
 * undercount tokens for long periods. Null when no request timings exist.
 */
export function splitEnergy(wh, ppMs, genMs, ppTok, genTok) {
  const total = (ppMs || 0) + (genMs || 0);
  if (!(total > 0)) return null;
  const ppWh = wh * (ppMs || 0) / total, genWh = wh - ppWh;
  return { ppWh, genWh, ppPer1k: per1k(ppWh, ppTok), genPer1k: per1k(genWh, genTok) };
}
