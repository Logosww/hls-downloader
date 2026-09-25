export type SaveFilePicker = (options: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<FileSystemFileHandle>;

export function getSaveFilePicker(): SaveFilePicker | undefined {
  if (typeof window === 'undefined' || !window.isSecureContext) return undefined;
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  return typeof picker === 'function' ? picker.bind(window) : undefined;
}

export function hasFilePicker(): boolean {
  return getSaveFilePicker() !== undefined;
}

export function filePickerOptions(title: string): Parameters<SaveFilePicker>[0] {
  const webm = title.endsWith('.webm');
  return {
    suggestedName: title,
    types: [
      webm
        ? { description: 'WebM Video', accept: { 'video/webm': ['.webm'] } }
        : { description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } },
    ],
  };
}

export function isUserAbort(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError';
}
