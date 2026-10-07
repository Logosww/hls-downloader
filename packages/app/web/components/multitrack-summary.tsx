import type { HlsMultiTrackReport } from '@hls-downloader/shared';
import { formatMediaTime } from '@/lib/timeline-options';
import { Button } from '@/components/ui/button';

export function MultiTrackSummary({
  report,
  onSave,
}: {
  report: HlsMultiTrackReport;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          多轨输出：{report.outputs.length} 个文件 · {formatMediaTime(report.duration)}
        </span>
        <Button variant="outline" size="sm" onClick={onSave}>
          保存多轨报告
        </Button>
      </div>
      {report.actualRange && (
        <span>
          实际范围：{formatMediaTime(report.actualRange.start)} –{' '}
          {formatMediaTime(report.actualRange.end)}
        </span>
      )}
      {report.tracks.map((track) => (
        <span key={`${track.outputIndex}:${track.id}`}>
          文件 {BigInt(track.outputIndex) + BigInt(1)} ·{' '}
          {track.kind === 'video' ? '视频' : track.kind === 'audio' ? '音轨' : '字幕'}{' '}
          {track.metadata.name || track.inputId} · {track.metadata.language} · {track.codec}
          {track.metadata.default ? ' · 默认' : ''}
        </span>
      ))}
      <span>
        字幕结果：
        {report.subtitleReports.filter((c) => c.disposition === 'Written').length} 写入 ·{' '}
        {report.subtitleReports.filter((c) => c.disposition === 'Clipped').length} 裁剪 ·{' '}
        {report.subtitleReports.filter((c) => c.disposition === 'RejectedLate').length} 迟到拒绝
      </span>
      {(report.historyTruncated ||
        report.trackHistoryTruncated ||
        report.subtitleHistoryTruncated) && <span>报告历史已按预算截断；统计仅含保留记录。</span>}
    </div>
  );
}
