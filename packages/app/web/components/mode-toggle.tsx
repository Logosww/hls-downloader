'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import { Menu, MenuItem, MenuSection, MenuTrigger } from '@/components/ui/menu';
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip';

export function ModeToggle() {
  const { setTheme } = useTheme();

  return (
    <MenuTrigger>
      <TooltipTrigger delay={300}>
        <Button intent="outline" size="sq-md" aria-label="切换主题">
          <Sun className="rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
        </Button>
        <Tooltip>切换主题</Tooltip>
      </TooltipTrigger>
      <Menu aria-label="主题" placement="bottom end" onAction={(key) => setTheme(String(key))}>
        <MenuSection>
          <MenuItem id="light">浅色</MenuItem>
          <MenuItem id="dark">深色</MenuItem>
          <MenuItem id="system">跟随系统</MenuItem>
        </MenuSection>
      </Menu>
    </MenuTrigger>
  );
}
