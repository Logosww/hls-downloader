import { useRef } from "react";

export enum Platform {
  web = 'web',
  tauri = 'tauri',
};

export const usePlatform = () => {
  const platform = useRef<Platform>(process.env.NEXT_PUBLIC_PLATFORM as Platform ?? Platform.web);

  return platform.current;
};

export default usePlatform;