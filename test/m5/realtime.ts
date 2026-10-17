// Pure clock model, shared by the source and acceptance checks. Polling never
// advances a playlist. The initial window exists before the recording starts.
export const segmentSeconds = (17 * 1024) / 44100;
export function realtimeWindow(
  elapsedMs: number,
  durationMs: number,
  mode: 'live' | 'event',
  batch = 16,
  seconds = segmentSeconds,
) {
  const step = batch / 2;
  const stepMs = step * seconds * 1000;
  const steps = Math.ceil(durationMs / stepMs);
  const published = Math.min(steps, Math.floor(Math.max(0, elapsedMs) / stepMs));
  const end = batch + published * step;
  return {
    start: mode === 'event' ? 0 : Math.max(0, end - batch),
    end,
    count: batch + steps * step,
    endList: elapsedMs >= durationMs && published === steps,
  };
}

/** Constant-space online trend calculation; raw samples are streamed to disk. */
export class Trend {
  n = 0;
  first = 0;
  last = 0;
  min = Infinity;
  max = -Infinity;
  sumX = 0;
  sumY = 0;
  sumXX = 0;
  sumXY = 0;
  add(elapsedMs: number, value: number) {
    const hours = elapsedMs / 3_600_000;
    if (!this.n) this.first = value;
    this.n++;
    this.last = value;
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
    this.sumX += hours;
    this.sumY += value;
    this.sumXX += hours * hours;
    this.sumXY += hours * value;
  }
  result(limitBytes: number) {
    const denominator = this.n * this.sumXX - this.sumX ** 2;
    return {
      samples: this.n,
      first: this.first,
      last: this.last,
      min: this.n ? this.min : null,
      max: this.n ? this.max : null,
      slopeBytesPerHour:
        denominator > 0 ? (this.n * this.sumXY - this.sumX * this.sumY) / denominator : null,
      growthBytes: this.n ? this.max - this.first : null,
      limitBytes,
      passed: this.n >= 2 && this.max - this.first <= limitBytes,
    };
  }
}
