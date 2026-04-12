/**
 * 发布前写入 adapters 的 optionalDependencies（与 @hls-downloader/adapters 的 version 一致）。
 * 勿将 optionalDependencies 提交进仓库：否则 frozen-lockfile 要求 lock 与 package.json 一致，
 * 且 CI 安装阶段会去解析尚未发布的 native 版本。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type PackageJson = {
  version?: string;
  optionalDependencies?: Record<string, string>;
};

const adaptersPackageJson = resolve(process.cwd(), 'packages/adapters/package.json');

const pkg = JSON.parse(readFileSync(adaptersPackageJson, 'utf8')) as PackageJson;
const version = pkg.version;
if (!version) {
  console.error('packages/adapters/package.json is missing version.');
  process.exit(1);
}

pkg.optionalDependencies = {
  '@hls-downloader/rust-native-darwin-arm64': version,
  '@hls-downloader/rust-native-darwin-x64': version,
  '@hls-downloader/rust-native-linux-arm64-gnu': version,
  '@hls-downloader/rust-native-linux-x64-gnu': version,
  '@hls-downloader/rust-native-win32-arm64-msvc': version,
  '@hls-downloader/rust-native-win32-x64-msvc': version,
};

writeFileSync(adaptersPackageJson, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log('Injected adapters optionalDependencies with native platform packages.');
