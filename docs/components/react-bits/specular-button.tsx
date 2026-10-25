'use client';

import {
  useEffect,
  useRef,
  type AnchorHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react';

import Link from 'next/link';
import { createSpecularRenderer, type Settings } from './specular-renderer';
import './specular-button.css';

// Adapted from React Bits SpecularButton (David Haz); see LICENSE.md.
// Navigation variant: preserves anchors, Next.js routing and open-in-new-tab.

export type SpecularButtonSize = 'sm' | 'md' | 'lg';

export interface SpecularButtonProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'children'
> {
  children?: ReactNode;
  size?: SpecularButtonSize;
  radius?: number;
  tint?: string;
  tintOpacity?: number;
  blur?: number;
  textColor?: string;
  lineColor?: string;
  baseColor?: string;
  intensity?: number;
  idleIntensity?: number;
  shineSize?: number;
  shineFade?: number;
  thickness?: number;
  glow?: number;
  speed?: number;
  followMouse?: boolean;
  proximity?: number;
  autoAnimate?: boolean;
  href: string;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const SpecularButton = ({
  children = 'Get Started',
  size = 'lg',
  radius = 18,
  tint = '#ffffff',
  tintOpacity = 0.04,
  blur = 0,
  textColor = '#f5f5f5',
  lineColor = '#ffffff',
  baseColor = '#525252',
  intensity = 1,
  idleIntensity = 0.35,
  shineSize = 10,
  shineFade = 34,
  thickness = 1.2,
  glow = 1,
  speed = 0.35,
  followMouse = true,
  proximity = 250,
  autoAnimate = false,
  onClick,
  className = '',
  href,
  style,
  ...rest
}: SpecularButtonProps) => {
  const buttonRef = useRef<HTMLAnchorElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wakeRef = useRef<(() => void) | null>(null);
  const settings: Settings = {
    radius: Math.max(0, radius),
    lineColor: String(lineColor),
    baseColor: String(baseColor),
    intensity: Math.max(0, intensity),
    idleIntensity: clamp(idleIntensity, 0, 1),
    shineSize: Math.max(0, shineSize),
    shineFade: Math.max(0, shineFade),
    thickness: Math.max(0, thickness),
    glow: Math.max(0, glow),
    speed,
    followMouse,
    proximity: Math.max(1, proximity),
    autoAnimate,
    disabled: false,
  };
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
    wakeRef.current?.();
  });

  useEffect(() => {
    const button = buttonRef.current;
    const canvas = canvasRef.current;
    if (!button || !canvas) return;
    const renderer = createSpecularRenderer(button, canvas, () => settingsRef.current);
    wakeRef.current = renderer?.wake ?? null;
    return () => {
      wakeRef.current = null;
      renderer?.destroy();
    };
  }, []);

  return (
    <Link
      ref={buttonRef}
      href={href}
      onClick={onClick}
      className={`specular-button specular-button--${size}${className ? ` ${className}` : ''}`}
      style={
        {
          '--sb-radius': `${radius}px`,
          '--sb-tint': tint,
          '--sb-tint-opacity': tintOpacity,
          '--sb-blur': `${blur}px`,
          '--sb-text-color': textColor,
          ...style,
        } as CSSProperties
      }
      {...rest}
    >
      <canvas ref={canvasRef} className="specular-button__light" aria-hidden="true" />
      <span className="specular-button__label">{children}</span>
    </Link>
  );
};

export default SpecularButton;
