/** Strict first; retry recognized TS AAC-LC overlaps once for atomic finite downloads. */
export type HlsAacOverlapRepair =
  | false
  | {
      /** Positive integer milliseconds; defaults to 50. */
      maxShiftMs?: number;
      /** Resource cache budget; defaults to 256 MiB. Exhaustion disables automatic retry. */
      maxCacheBytes?: number;
    };
export type HlsAacRepairPosition = {
  slot: HlsTimelineSlot;
  original: HlsMediaTime;
  repaired: HlsMediaTime;
};
export type HlsAacRepairSummary = {
  inputId: string;
  correctedFrames: string;
  maxShift: HlsMediaTime;
  first: HlsAacRepairPosition | null;
  last: HlsAacRepairPosition | null;
};
export type HlsAacOverlapDiagnostic = {
  slot: HlsTimelineSlot;
  original: HlsMediaTime;
  expected: HlsMediaTime;
  overlap: HlsMediaTime;
};
export type HlsAacRepairDiagnostic = {
  position: HlsAacRepairPosition;
  maxShiftMs: number;
};
/** Exact signed media time. Protocol integers never pass through a JS number. */
export type HlsMediaTime = { ticks: string; timescale: number };
export type HlsPresentationRange = { start: HlsMediaTime; end: HlsMediaTime };
export type HlsTimelineOptions = {
  range?: HlsPresentationRange;
  aacOverlapRepair?: HlsAacOverlapRepair;
  gapPolicy?: 'preserve' | 'collapse';
  epochAnchors?: {
    inputId: 'primary' | 'audio';
    epoch: string;
    source: HlsMediaTime;
    presentation: HlsMediaTime;
  }[];
  limits?: { samples?: number; resources?: number };
  tailDuration?: HlsMediaTime;
};
export type HlsMultiTimelineOptions = HlsTimelineOptions & { changePolicy?: 'fail' | 'split' };
export type HlsTimelineMapping = {
  inputId: string;
  trackId: number;
  epoch: string;
  sourceOrigin: HlsMediaTime;
  sourceDecodeStart: HlsMediaTime;
  configurationId: number[];
  presentation: HlsPresentationRange;
  outputStart: HlsMediaTime;
  outputIndex: string;
  wrapAnchor: HlsMediaTime | null;
  programDateTime: string | null;
};
export type HlsTimelineTrack = {
  codec: string;
  timescale: number;
  duration: string;
  sampleCount: string;
};
export type HlsTimelineOutputDescriptor = {
  index: string;
  actualRange: HlsPresentationRange;
  reason: 'Initial' | 'ConfigurationChanged' | 'Gap' | 'Unknown';
  tracks: HlsTimelineTrack[];
};
export type HlsTimelineOutputReport = HlsTimelineOutputDescriptor & {
  bytesWritten: string;
  mappings: HlsTimelineMapping[];
};
export type HlsTimelineMap = {
  schemaVersion: 2;
  complete: boolean;
  outputs: HlsTimelineOutputReport[];
  gaps: HlsPresentationRange[];
};
export type HlsTimelineSlot = {
  inputId: string;
  generation: string;
  epoch: string;
  sequence: string;
};
export type HlsCompletedOutput = import('./recording').HlsRecordingOutputRequest & {
  filePath?: string;
  bytesWritten?: string;
};
export type HlsOutputFactory = (
  output: import('./recording').HlsRecordingOutputRequest,
) => Promise<WritableStream<Uint8Array>>;
export type HlsOutputsResult<T> = {
  operationId: string;
  totalSegments: number;
  outputs: (Omit<T, 'totalSegments' | 'report'> & { index: string })[];
  report: import('./multitrack').HlsEngineReport;
};
export type HlsSidecar = {
  outputIndex: string;
  text: string;
  filename: string;
  mimeType: 'text/vtt';
};
export type HlsTimelineTrackSelection = { inputId: string; trackId: number };
export type HlsChapter = { range: HlsPresentationRange; title: string; id?: string };
export type HlsChapterOptions = {
  chapters: readonly HlsChapter[];
  timelineMap: HlsTimelineMap;
  track?: HlsTimelineTrackSelection;
  filename?: string;
};
