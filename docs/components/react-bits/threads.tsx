'use client';

import { useEffect, useRef, type HTMLAttributes } from 'react';

// Adapted from React Bits Threads (David Haz). See LICENSE.md in this directory.
// Source: https://github.com/DavidHDev/react-bits/tree/main/src/ts-default/Backgrounds/Threads
import { createThreadsRenderer, type Settings } from './threads-renderer';
import './threads.css';

export interface ThreadsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'color'> {
  color?: string | [number, number, number];
  accentColor?: string | [number, number, number];
  amplitude?: number;
  distance?: number;
  enableMouseInteraction?: boolean;
  lineCount?: number;
  thickness?: number;
  softness?: number;
  speed?: number;
  waves?: number;
  split?: number;
  fray?: number;
  angle?: number;
  seed?: number;
  parting?: number;
  taper?: number;
  brightness?: number;
  fade?: number;
  opacity?: number;
  paused?: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const Threads = ({
  color = [1, 1, 1],
  accentColor,
  amplitude = 1.7,
  distance = 0.4,
  enableMouseInteraction = false,
  lineCount = 90,
  thickness = 0.6,
  softness = 1.3,
  speed = 0.6,
  waves = 1.05,
  split = 0.04,
  fray = 0.5,
  angle = 25,
  seed = 0,
  parting = 0,
  taper = 0.85,
  brightness = 1.4,
  fade = 0,
  opacity = 1,
  paused = false,
  ...rest
}: ThreadsProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wakeRef = useRef<(() => void) | null>(null);
  const colorKey = `${Array.isArray(color) ? color.join(',') : String(color)}|${
    Array.isArray(accentColor) ? accentColor.join(',') : String(accentColor ?? '')
  }`;
  const settings: Settings = {
    color,
    accentColor,
    colorKey,
    amplitude,
    distance,
    enableMouseInteraction,
    lineCount: clamp(Math.round(lineCount), 1, 400),
    thickness: Math.max(0, thickness),
    softness: Math.max(0, softness),
    speed,
    waves: Math.max(0, waves),
    split: clamp(split, 0, 1),
    fray: clamp(fray, 0, 1),
    angle,
    seed,
    parting: clamp(parting, 0, 1),
    taper: clamp(taper, 0, 1),
    brightness: clamp(brightness, 0.25, 2),
    fade: clamp(fade, 0, 1),
    opacity: clamp(opacity, 0, 1),
    paused,
  };
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
    wakeRef.current?.();
  });

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const renderer = createThreadsRenderer(container, canvas, () => settingsRef.current);
    wakeRef.current = renderer?.wake ?? null;
    return () => {
      wakeRef.current = null;
      renderer?.destroy();
    };
  }, []);

  const { className = '', ...attributes } = rest;

  return (
    <div
      ref={containerRef}
      className={`threads-container${className ? ` ${className}` : ''}`}
      {...attributes}
    >
      <canvas ref={canvasRef} className="threads-canvas" aria-hidden="true" />
    </div>
  );
};

export default Threads;
