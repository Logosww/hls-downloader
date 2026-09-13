export const encryptedPlaylist = (method: 'AES-128' | 'SAMPLE-AES') =>
  `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=${method},URI="key.bin"\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n`;

export const unsupportedMediaScenarios = [
  ['live', '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n'],
  [
    'event',
    '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n',
  ],
  [
    'discontinuity',
    '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-DISCONTINUITY\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n',
  ],
] as const;

export const alternateRenditionMaster =
  '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="audio"\nvideo.m3u8\n';

export const emptyMaster =
  '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="audio.m3u8"\n';
