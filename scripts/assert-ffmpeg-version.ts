import { spawnSync } from 'node:child_process';

const pkgConfigBin = process.env.PKG_CONFIG || 'pkg-config';
const minMajor = Number(process.env.FFMPEG_LIBAVCODEC_MIN_MAJOR || '60');
const maxMajor = Number(process.env.FFMPEG_LIBAVCODEC_MAX_MAJOR || '62');

function runCapture(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || '');
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
  return result.stdout.trim();
}

function parseMajor(version: string): number {
  const major = Number(version.split('.')[0]);
  if (!Number.isFinite(major)) {
    throw new Error(`Unable to parse major version from: ${version}`);
  }
  return major;
}

try {
  const codecVersion = runCapture(pkgConfigBin, ['--modversion', 'libavcodec']);
  const formatVersion = runCapture(pkgConfigBin, ['--modversion', 'libavformat']);
  const codecMajor = parseMajor(codecVersion);

  if (codecMajor < minMajor || codecMajor > maxMajor) {
    throw new Error(
      `libavcodec version ${codecVersion} (major ${codecMajor}) is out of supported range ${minMajor}-${maxMajor}`,
    );
  }

  console.log(`FFmpeg binding check passed: libavcodec=${codecVersion}, libavformat=${formatVersion}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
