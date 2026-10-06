/** Exact signed media time. Protocol integers never pass through a JS number. */
export type HlsMediaTime = { ticks: string; timescale: number };
export type HlsPresentationRange = { start: HlsMediaTime; end: HlsMediaTime };
export type HlsTimelineOptions = {
  range?: HlsPresentationRange;
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
  reason: 'Initial' | 'ConfigurationChanged' | 'Gap';
  tracks: HlsTimelineTrack[];
};
export type HlsTimelineOutputReport = HlsTimelineOutputDescriptor & {
  bytesWritten: string;
  mappings: HlsTimelineMapping[];
};
export type HlsTimelineReport = {
  schemaVersion: 1;
  requested: HlsPresentationRange | null;
  actual: HlsPresentationRange;
  preroll: HlsPresentationRange | null;
  postroll: HlsPresentationRange | null;
  outputs: HlsTimelineOutputReport[];
  gaps: HlsPresentationRange[];
  dependencies: {
    slot: HlsTimelineSlot;
    map: { revision: string; ordinal: string } | null;
    keys: { revision: string; ordinal: string }[];
    mapKeys: { revision: string; ordinal: string }[];
  }[];
  randomAccessPoints: {
    slot: HlsTimelineSlot;
    sampleIndex: string;
    source: HlsMediaTime;
    presentation: HlsMediaTime;
    outputIndex: string;
  }[];
  indexedResources: string;
  resourceReads: string;
  sourceBytes: string;
  peakPlannedSamples: string;
  peakPlannedResources: string;
};
export type HlsTimelineSlot = {
  inputId: string;
  generation: string;
  epoch: string;
  sequence: string;
};
export type HlsCompletedOutput = HlsTimelineOutputDescriptor & {
  filePath?: string;
  bytesWritten?: string;
};
export type HlsOutputFactory = (
  output: HlsTimelineOutputDescriptor,
) => Promise<WritableStream<Uint8Array>>;
export type HlsOutputsResult<T> = {
  operationId: string;
  totalSegments: number;
  outputs: (Omit<T, 'totalSegments' | 'timelineReport'> & { index: string })[];
  timelineReport: HlsTimelineReport;
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
  timelineReport: HlsTimelineReport;
  track?: HlsTimelineTrackSelection;
  filename?: string;
};
