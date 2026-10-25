'use client';

import { useState } from 'react';
import { Check, Copy, Terminal } from 'lucide-react';

const command = 'npm i @logosw/hls-downloader';

export function InstallCommand({ lang }: { lang: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const zh = lang === 'zh';
  const label =
    status === 'copied' ? (zh ? '已复制' : 'Copied') : zh ? '复制安装命令' : 'Copy install command';

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setStatus('copied');
    } catch {
      setStatus('error');
    }
  }

  return (
    <div className="hero-install-wrap">
      <div className="hero-install">
        <Terminal size={16} aria-hidden="true" />
        <code>{command}</code>
        <button type="button" onClick={copy} aria-label={label} title={label}>
          {status === 'copied' ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      <span className="hero-copy-status" role="status">
        {status === 'copied'
          ? label
          : status === 'error'
            ? zh
              ? '未能复制，请选中命令手动复制。'
              : 'Could not copy. Select the command to copy manually.'
            : ''}
      </span>
    </div>
  );
}
