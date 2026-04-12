import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type PackageJson = {
  version: string;
  optionalDependencies?: Record<string, string>;
};

const adaptersPackageJson = resolve(process.cwd(), 'packages/adapters/package.json');
const pkg = JSON.parse(readFileSync(adaptersPackageJson, 'utf8')) as PackageJson;
const version = pkg.version;

pkg.optionalDependencies = {
  '@hls-downloader/rust-native-darwin-arm64': version,
  '@hls-downloader/rust-native-darwin-x64': version,
  '@hls-downloader/rust-native-linux-arm64-gnu': version,
  '@hls-downloader/rust-native-linux-x64-gnu': version,
  '@hls-downloader/rust-native-win32-x64-msvc': version,
};

writeFileSync(adaptersPackageJson, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log('Injected adapters optionalDependencies with native platform packages.');
