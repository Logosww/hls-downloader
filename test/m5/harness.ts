import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '../..');
export const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export function evidence(gate: string, out?: string) {
  const directory = out
    ? resolve(out)
    : join(
        root,
        'test-results/m5',
        `${gate}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`,
      );
  mkdirSync(resolve(directory, '..'), { recursive: true });
  mkdirSync(directory);
  const summary: any = {
    schemaVersion: 1,
    gate,
    status: 'running',
    startedAt: new Date().toISOString(),
    host: { platform: platform(), arch: arch(), release: release(), node: process.version },
    steps: [],
  };
  const save = () => {
    writeFileSync(join(directory, 'summary.tmp'), JSON.stringify(summary, null, 2) + '\n');
    renameSync(join(directory, 'summary.tmp'), join(directory, 'summary.json'));
  };
  save();
  console.log(`Evidence: ${directory}`);
  const controller = new AbortController();
  let signal: string | undefined;
  const handlers = ['SIGINT', 'SIGTERM'].map((s) => {
    const handler = () => {
      signal = s;
      controller.abort(Error(s));
    };
    process.on(s, handler);
    return [s, handler] as const;
  });
  const heartbeat = setInterval(
    () => console.log(`${gate}: ${summary.steps.at(-1)?.name ?? 'running'}`),
    60_000,
  );
  async function run(
    name: string,
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  ) {
    if (controller.signal.aborted) throw controller.signal.reason;
    const step: any = {
      name,
      command,
      args,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    summary.steps.push(step);
    save();
    const log = join(directory, `${summary.steps.length}-${name}.log`);
    console.log(`Start: ${name}`);
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const kill = (force: boolean) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32')
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        /* already exited */
      }
    };
    const cancel = () => {
      kill(false);
      killTimer ??= setTimeout(() => kill(true), 10_000);
    };
    controller.signal.addEventListener('abort', cancel, { once: true });
    const deadline = setTimeout(() => {
      timedOut = true;
      cancel();
    }, options.timeoutMs ?? 600_000);
    const output = (bytes: Buffer) => appendFileSync(log, bytes);
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    try {
      await new Promise<void>((accept, reject) => {
        child.on('error', reject);
        child.on('close', (code, childSignal) => {
          step.exitCode = code;
          step.signal = childSignal;
          if (timedOut || controller.signal.aborted || code !== 0)
            reject(
              Error(
                `${name}: ${timedOut ? 'timeout' : controller.signal.aborted ? signal : `exit ${code}/${childSignal}`}; see ${log}`,
              ),
            );
          else accept();
        });
      });
      step.status = 'passed';
    } catch (error) {
      step.status = 'failed';
      step.error = String(error);
      throw error;
    } finally {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      controller.signal.removeEventListener('abort', cancel);
      step.finishedAt = new Date().toISOString();
      save();
    }
  }
  async function finish(work: () => Promise<void>) {
    try {
      await work();
      if (controller.signal.aborted) throw controller.signal.reason;
      summary.status = 'passed';
    } catch (error) {
      summary.status = signal ? 'interrupted' : 'failed';
      summary.error = String(error);
      console.error(error);
      process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
    } finally {
      clearInterval(heartbeat);
      handlers.forEach(([s, h]) => process.off(s, h));
      summary.finishedAt = new Date().toISOString();
      save();
      console.log(`${summary.status}: ${join(directory, 'summary.json')}`);
    }
  }
  return { directory, summary, save, run, finish, signal: controller.signal };
}
export function pnpmArgs(args: string[]) {
  if (!process.env.npm_execpath)
    throw Error('Run through pnpm test:m5:gates (npm_execpath is required).');
  return /\.[cm]?js$/.test(process.env.npm_execpath) ? [process.env.npm_execpath, ...args] : args;
}

export function pnpmCommand() {
  if (!process.env.npm_execpath) throw Error('Run through pnpm test:m5:gates');
  return /\.[cm]?js$/.test(process.env.npm_execpath) ? process.execPath : process.env.npm_execpath;
}
