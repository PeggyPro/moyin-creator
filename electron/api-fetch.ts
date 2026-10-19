// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.

import { withRequestDeadline } from '../src/lib/request-deadline';
import type { IpcMain } from 'electron';
import type { ApiFetchRequest, ApiFetchResult } from '../src/types/api-fetch';

/** Send provider HTTP requests from the main process, outside renderer CORS. */
export function registerApiFetchHandlers(ipc: IpcMain, fetchImpl: typeof fetch): void {
  const pending = new Map<string, AbortController>();

  ipc.handle('api-fetch', async (event, request: ApiFetchRequest): Promise<ApiFetchResult> => {
    const key = `${event.sender.id}:${request.id}`;
    const controller = new AbortController();
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('网络请求仅支持 HTTP 或 HTTPS 地址');
      }
      if (!request.id || pending.has(key)) {
        throw new Error('无效或重复的网络请求标识');
      }
      pending.set(key, controller);
      return await withRequestDeadline(async (signal): Promise<ApiFetchResult> => {
      const response = await fetchImpl(url.href, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal,
      });
      const body = await response.arrayBuffer();
      return {
        success: true,
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()),
        body,
      };
      }, { signal: controller.signal });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timedOut: error instanceof Error && error.name === 'TimeoutError',
        aborted: controller.signal.aborted,
      };
    } finally {
      if (pending.get(key) === controller) pending.delete(key);
    }
  });

  ipc.on('api-fetch-abort', (event, id: string) => {
    pending.get(`${event.sender.id}:${id}`)?.abort();
  });
}
