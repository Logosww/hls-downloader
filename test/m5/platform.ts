import { parseArgs } from 'node:util';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { evidence, root, hash, pnpmArgs, pnpmCommand } from './harness.ts';
const { values } = parseArgs({
  options: { out: { type: 'string' }, 'allow-dynamic': { type: 'boolean' } },
});
const suffix =
  process.platform === 'linux'
    ? `linux-${process.arch}-gnu`
    : process.platform === 'win32'
      ? `win32-${process.arch}-msvc`
      : `darwin-${process.arch}`;
if (
  ![
    'linux-x64-gnu',
    'linux-arm64-gnu',
    'darwin-x64',
    'darwin-arm64',
    'win32-x64-msvc',
    'win32-arm64-msvc',
  ].includes(suffix)
)
  throw Error('Run on one of the six supported native hosts');
const e = evidence('platform', values.out);
e.summary.target = suffix;
e.summary.qualification = values['allow-dynamic']
  ? 'dynamic local smoke only; not static platform acceptance'
  : 'static platform package acceptance';
e.summary.commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
e.summary.dirty = !!execFileSync('git', ['status', '--porcelain'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const save = (p: string, value: any) => writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
await e.finish(async () => {
  if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH || process.env.NODE_PATH)
    throw Error('Unset NAPI_RS_NATIVE_LIBRARY_PATH and NODE_PATH to test package routing');
  const binary = join(root, `packages/adapters/dist/native.${suffix}.node`);
  if (!existsSync(binary)) throw Error(`Build the matching Native distribution first: ${binary}`);
  e.summary.binary = { path: binary, sha256: hash(binary) };
  const tool =
    process.platform === 'darwin' ? 'otool' : process.platform === 'linux' ? 'ldd' : 'dumpbin';
  await e.run('linkage', tool, [
    process.platform === 'darwin' ? '-L' : process.platform === 'win32' ? '/DEPENDENTS' : binary,
    ...(process.platform === 'linux' ? [] : [binary]),
  ]);
  const linkage = readFileSync(join(e.directory, '1-linkage.log'), 'utf8');
  let dependencies =
    process.platform === 'darwin'
      ? linkage
          .split('\n')
          .slice(1)
          .map((s) => s.trim().split(' ')[0])
          .filter(Boolean)
      : process.platform === 'linux'
        ? linkage
            .split('\n')
            .map((s) => s.trim().split(' ')[0])
            .filter(Boolean)
        : (linkage.match(/\b[\w.-]+\.dll\b/gi) ?? []);
  if (process.platform === 'darwin') {
    await e.run('install-name', 'otool', ['-D', binary]);
    const ownInstallName = readFileSync(join(e.directory, '2-install-name.log'), 'utf8')
      .split('\n')[1]
      ?.trim();
    dependencies = dependencies.filter((name) => name !== ownInstallName);
  }
  const allowed =
    process.platform === 'darwin'
      ? /^(\/usr\/lib\/|\/System\/Library\/)/
      : process.platform === 'linux'
        ? /^(linux-vdso|lib(c|m|dl|pthread|rt|gcc_s|stdc\+\+|util)\.|\/.*ld-linux)/
        : /^(kernel32|ntdll|user32|advapi32|ws2_32|bcrypt|crypt32|ole32|oleaut32|shell32|shlwapi|secur32|userenv|normaliz|psapi|gdi32|msvcrt|vcruntime[\w]*|msvcp[\w]*|ucrtbase|api-ms-[\w-]+)\.dll$/i;
  const unexpected = dependencies.filter((d) => !allowed.test(d));
  e.summary.linkage = { dependencies, unexpected, static: unexpected.length === 0 };
  if (!values['allow-dynamic'] && unexpected.length)
    throw Error(`Non-system dynamic dependencies: ${unexpected.join(', ')}`);
  if (!dependencies.length) throw Error('No linkage dependencies were parsed');
  const consumerRoot = mkdtempSync(join(tmpdir(), 'hls-m5-install-'));
  e.summary.consumerRoot = consumerRoot;
  const tarballs: Record<string, string> = {};
  async function pack(name: string, directory: string) {
    const target = join(e.directory, 'tarballs');
    mkdirSync(target, { recursive: true });
    await e.run(
      `pack-${name.split('/').at(-1)}`,
      pnpmCommand(),
      pnpmArgs(['exec', 'npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', target]),
      { cwd: directory },
    );
    const info = JSON.parse(
      readFileSync(
        join(e.directory, `${e.summary.steps.length}-pack-${name.split('/').at(-1)}.log`),
        'utf8',
      ),
    );
    tarballs[name] = join(target, info[0].filename);
  }
  const nativeName = `@hls-downloader/rust-native-${suffix}`;
  const nativeDir = join(e.directory, 'native-package');
  mkdirSync(nativeDir);
  const version = json(join(root, 'packages/adapters/package.json')).version;
  cpSync(binary, join(nativeDir, `native.${suffix}.node`));
  save(join(nativeDir, 'package.json'), {
    name: nativeName,
    version,
    main: `native.${suffix}.node`,
    files: [`native.${suffix}.node`],
    os: [process.platform],
    cpu: [process.arch],
  });
  await pack(nativeName, nativeDir);
  for (const relative of ['packages/shared', 'packages/core', 'packages/adapters', '.']) {
    const pkg = json(join(root, relative, 'package.json'));
    const staging = join(e.directory, 'staging', pkg.name.split('/').at(-1));
    mkdirSync(staging, { recursive: true });
    cpSync(join(root, relative, 'dist'), join(staging, 'dist'), {
      recursive: true,
      filter: (path) => !path.endsWith('.node'),
    });
    for (const [name, spec] of Object.entries(pkg.dependencies ?? {}))
      if (String(spec).startsWith('workspace:')) pkg.dependencies[name] = version;
    delete pkg.scripts;
    delete pkg.workspaces;
    delete pkg.devDependencies;
    delete pkg.packageManager;
    if (relative === 'packages/adapters')
      pkg.optionalDependencies = { [nativeName]: `file:${tarballs[nativeName]}` };
    save(join(staging, 'package.json'), pkg);
    await pack(pkg.name, staging);
  }
  e.summary.tarballs = Object.fromEntries(
    Object.entries(tarballs).map(([name, path]) => [name, { path, sha256: hash(path) }]),
  );
  for (const missing of [false, true]) {
    const consumer = join(consumerRoot, missing ? 'missing-native' : 'consumer');
    mkdirSync(consumer);
    save(join(consumer, 'package.json'), {
      name: 'm5-consumer',
      private: true,
      type: 'module',
      dependencies: Object.fromEntries(
        Object.entries(tarballs)
          .filter(([name]) => name !== nativeName)
          .map(([name, path]) => [name, `file:${path}`]),
      ),
    });
    await e.run(
      missing ? 'install-missing' : 'install-native',
      pnpmCommand(),
      pnpmArgs([
        'exec',
        'npm',
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        ...(missing ? ['--omit=optional'] : []),
      ]),
      { cwd: consumer },
    );
    const script = missing
      ? `
await import('@hls-downloader/core'); await import('@hls-downloader/adapters/browser');
let rejected = false; try { const { NodeAdapter } = await import('@hls-downloader/adapters/node'); const { HlsDownloader } = await import('@hls-downloader/core'); await new HlsDownloader({adapter:NodeAdapter}).downloadToWritable({url:'http://127.0.0.1:1/unavailable'},new WritableStream()); } catch (error) { if (!/native binding|Cannot find module|native.*unavailable/i.test(String(error))) throw error; rejected = true; }
if (!rejected) throw Error('Missing native dependency unexpectedly worked');
`
      : `
import { createRequire } from 'node:module'; import {fileURLToPath} from 'node:url'; import { readFileSync, readdirSync } from 'node:fs'; import { createServer } from 'node:http'; import { once } from 'node:events';
import { HlsDownloader, NodeAdapter } from '@logosw/hls-downloader';
const require = createRequire(import.meta.url);
const adapterRequire = createRequire(import.meta.resolve('@hls-downloader/adapters/node'));
const binding = adapterRequire.resolve(${JSON.stringify(nativeName)});
if (!binding.startsWith(fileURLToPath(new URL('./node_modules/', import.meta.url)))) throw Error('Native binding resolved outside consumer');
if ( readdirSync(new URL('./node_modules/@hls-downloader/adapters/dist/', import.meta.url)).some(f=>f.endsWith('.node'))) throw Error('Source-adjacent native fallback');
const server=createServer((req,res)=>res.end(req.url.endsWith('.m3u8')?'#EXTM3U\\n#EXT-X-TARGETDURATION:1\\n#EXTINF:0.394739229,\\nsegment.bin\\n#EXT-X-ENDLIST\\n':readFileSync(new URL('./fixture.bin', import.meta.url))));
server.listen(0,'127.0.0.1'); await once(server,'listening'); let bytes=0;
try { const r=await new HlsDownloader({adapter:NodeAdapter}).downloadMultiTrack({url:'http://127.0.0.1:'+server.address().port+'/media.m3u8',embeddedAudio:'keep',output:{type:'writable',writable:new WritableStream({write(b){bytes+=b.length}})}}); if (!bytes || r.report.inputs[0].committed!=='1') throw Error('Native package did not process media'); if (!require.cache[binding]) throw Error('Resolved platform binary was not loaded'); console.log(JSON.stringify({binding,bytes,report:r.report})); } finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); }
`;
    const payloadCheck = `
import { readFileSync as readPayload, existsSync as hasPayload } from 'node:fs';
for (const name of ['@logosw/hls-downloader','@hls-downloader/shared','@hls-downloader/core','@hls-downloader/adapters']) {
  const directory=new URL('./node_modules/'+name+'/',import.meta.url);
  const pkg=JSON.parse(readPayload(new URL('package.json',directory),'utf8'));
  for (const entry of Object.values(pkg.exports ?? {'.':{import:pkg.main,types:pkg.types}})) for (const field of ['import','types']) if (entry[field] && !hasPayload(new URL(entry[field],directory))) throw Error('Missing export '+name+' '+entry[field]);
}
await WebAssembly.compile(readPayload(new URL('./node_modules/@hls-downloader/adapters/dist/hls_transmux_browser_wasm_bg.wasm',import.meta.url)));
`;
    writeFileSync(join(consumer, 'verify.mjs'), payloadCheck + script);
    cpSync(join(root, 'test/fixtures/packed-aac/clear/seg0.bin'), join(consumer, 'fixture.bin'));
    await e.run(missing ? 'missing-contract' : 'native-runtime', process.execPath, ['verify.mjs'], {
      cwd: consumer,
    });
  }
  const typeConsumer = join(consumerRoot, 'consumer/check.ts');
  writeFileSync(
    typeConsumer,
    `import {HlsDownloader, NodeAdapter} from '@logosw/hls-downloader'; import {BrowserAdapter} from '@logosw/hls-downloader/adapters/browser'; new HlsDownloader({adapter:NodeAdapter}).startRecording({url:'http://fixture/live.m3u8',output:{type:'file',path:'recording.mp4'}}); new HlsDownloader({adapter:BrowserAdapter}).downloadToWritable({url:'http://fixture/vod.m3u8'}, new WritableStream<Uint8Array>());`,
  );
  await e.run(
    'consumer-types',
    pnpmCommand(),
    pnpmArgs([
      'exec',
      'tsc',
      '--ignoreConfig',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'esnext',
      '--module',
      'nodenext',
      typeConsumer,
    ]),
  );
  // Evaluate the shipped loader on an unsupported OS without changing the host.
  const unsupported = join(e.directory, 'unsupported.cjs');
  writeFileSync(
    unsupported,
    `const vm=require('node:vm'),fs=require('node:fs'); const source=fs.readFileSync(${JSON.stringify(join(root, 'packages/adapters/dist/native.js'))},'utf8'); let rejected=false; try { vm.runInNewContext(source,{require,process:{platform:'plan9',arch:'x64',env:{}},module:{exports:{}},exports:{},__dirname:__dirname}); } catch(e) { let reason=e, unsupported=false; while(reason) { unsupported ||= /Unsupported OS|Unsupported platform/i.test(String(reason)); reason=reason.cause; } if(!unsupported) throw e; rejected=true; } if(!rejected) throw Error('Unsupported target did not reject');`,
  );
  await e.run('unsupported-target', process.execPath, [unsupported]);
});
