import { expect, it } from 'vitest';
import { realtimeWindow, segmentSeconds, Trend } from './m5/realtime';

it('repeated polling cannot accelerate real-time publication or EOF', () => {
  const duration = 7_200_000;
  const initial = realtimeWindow(0, duration, 'live');
  for (let i = 0; i < 1000; i++) expect(realtimeWindow(1, duration, 'live')).toEqual(initial);
  const stepMs = segmentSeconds * 8 * 1000;
  expect(realtimeWindow(stepMs - 1, duration, 'live').end).toBe(16);
  expect(realtimeWindow(stepMs, duration, 'live')).toMatchObject({
    start: 8,
    end: 24,
    endList: false,
  });
  expect(realtimeWindow(duration - 1, duration, 'live').endList).toBe(false);
  const final = realtimeWindow(duration + stepMs, duration, 'live');
  expect(final.endList).toBe(true);
  expect(final.end).toBe(final.count);
  expect(final.end - final.start).toBe(16);
});

it('EVENT retains every published segment while sharing the same clock and EOF', () => {
  for (const ms of [0, 10_000, 7_199_999, 7_204_000]) {
    const live = realtimeWindow(ms, 7_200_000, 'live');
    const event = realtimeWindow(ms, 7_200_000, 'event');
    expect(event).toEqual({ ...live, start: 0 });
  }
});

it('reports online memory growth and hourly slope without retaining samples', () => {
  const stats = new Trend();
  stats.add(0, 100);
  stats.add(3_600_000, 200);
  stats.add(7_200_000, 300);
  expect(stats.result(200)).toMatchObject({
    samples: 3,
    growthBytes: 200,
    slopeBytesPerHour: 100,
    passed: true,
  });
  expect(stats.result(199).passed).toBe(false);
  expect(new Trend().result(200).passed).toBe(false);
  const single = new Trend();
  single.add(0, 100);
  expect(single.result(200).passed).toBe(false);
});
