import { timelineCases, timelineRoutes } from './timeline.ts';
export const recordingCases = timelineCases.filter(
  (c) =>
    ['range-False', 'range-True', 'dual-False', 'dual-True'].includes(c.name) ||
    (c.name.startsWith('sample-') && c.name !== 'sample-range-key-redeclaration'),
);
export function recordingRoutes(c: any, prefix = '') {
  const copy = structuredClone(c);
  for (const snapshot of [copy.request.primary, copy.request.audio].filter(Boolean))
    snapshot.text = snapshot.text
      .replace(/^#EXT-X-ENDLIST.*\n?/gm, '')
      .replace(/^#EXT-X-PLAYLIST-TYPE.*\n?/gm, '');
  return timelineRoutes(copy, prefix);
}
