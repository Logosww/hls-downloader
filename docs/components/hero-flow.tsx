'use client';

import dynamic from 'next/dynamic';
import { useState, useSyncExternalStore } from 'react';
import { Pause, Play } from 'lucide-react';
import brand from '@/lib/brand.json';

const Threads = dynamic(() => import('@/components/react-bits/threads'), { ssr: false });

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

const getDarkTheme = () => document.documentElement.classList.contains('dark');
const getServerTheme = () => false;

export function HeroFlow({ lang }: { lang: string }) {
  const [paused, setPaused] = useState(false);
  const dark = useSyncExternalStore(subscribeTheme, getDarkTheme, getServerTheme);
  const zh = lang === 'zh';

  return (
    <>
      <div className="hero-flow" aria-hidden="true">
        <svg className="flow-traces" viewBox="0 0 1400 700" fill="none" preserveAspectRatio="none">
          <path d="M-100 640C300 640 600 430 850 380S1200 140 1500 80" />
          <path d="M-100 660C300 660 600 440 850 400S1200 180 1500 100" />
          <path d="M-100 680C300 680 600 450 850 420S1200 220 1500 120" />
        </svg>
        <div className="flow-threads">
          <Threads
            color={dark ? brand.colors.mint : brand.colors.deep}
            angle={27}
            amplitude={0.9}
            distance={0.22}
            lineCount={48}
            thickness={1.1}
            softness={0.65}
            speed={0.35}
            brightness={1.7}
            taper={0.35}
            fade={0.2}
            parting={0.35}
            enableMouseInteraction
            paused={paused}
          />
        </div>
      </div>
      <button
        type="button"
        className="flow-pause"
        onClick={() => setPaused(!paused)}
        aria-pressed={paused}
        aria-label={
          zh
            ? paused
              ? '播放背景动画'
              : '暂停背景动画'
            : paused
              ? 'Play background animation'
              : 'Pause background animation'
        }
      >
        {paused ? <Play size={16} /> : <Pause size={16} />}
      </button>
    </>
  );
}
