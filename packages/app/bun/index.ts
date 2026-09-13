import { NodeAdapter } from '@hls-downloader/adapters/node';
import { HlsDownloader } from '@hls-downloader/core';
import { createApp } from './app';
import { TaskManager } from './task-manager';

const port = Number(process.env.PORT) || 3000;
const fileExpiryMs = Number(process.env.FILE_EXPIRY_MS) || 30 * 60 * 1_000;
const maxActiveTasks = Number(process.env.MAX_ACTIVE_TASKS) || 3;

let manager: TaskManager;
const downloader = new HlsDownloader({
  adapter: NodeAdapter,
  onEvent: (event, payload) => manager?.handleSdkEvent(event, payload),
});
manager = new TaskManager(downloader, { fileExpiryMs, maxActiveTasks });

const app = createApp(manager).listen(port);
console.log(`HLS Downloader API running at http://localhost:${app.server?.port}`);
