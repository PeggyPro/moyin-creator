// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * Provider HTTP transport. Electron uses its main process; browser development
 * uses the existing Vite proxy. Browser production requires server-side CORS.
 */

import type { ApiFetchBridge } from '@/types/api-fetch';

export async function corsFetch(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const targetUrl = url.toString();
  const headers = new Headers(init?.headers);
  if (/^Bearer\s*$/i.test(headers.get('Authorization') || '')) {
    headers.delete('Authorization');
  }
  const requestInit = init ? { ...init, headers } : undefined;
  const isHttp = /^https?:\/\//i.test(targetUrl);
  const bridge = typeof window !== 'undefined' ? window.apiFetch : undefined;

  if (!isHttp || (!bridge && import.meta.env?.DEV !== true)) {
    return fetch(targetUrl, requestInit);
  }
  if (init?.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');

  // Request supplies the correct multipart boundary/content type for FormData.
  const request = new Request(targetUrl, requestInit);
  const body = request.body ? await request.arrayBuffer() : undefined;
  if (init?.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');

  if (bridge) return fetchThroughBridge(bridge, request, body, init?.signal);

  const originalHeaders = Object.fromEntries(request.headers.entries());
  return fetch(`/__api_proxy?url=${encodeURIComponent(targetUrl)}`, {
    ...init,
    method: request.method,
    headers: {
      'Content-Type': 'application/json',
      'x-proxy-headers': JSON.stringify(originalHeaders),
    },
    body,
  });
}

async function fetchThroughBridge(
  bridge: ApiFetchBridge,
  request: Request,
  body: ArrayBuffer | undefined,
  signal?: AbortSignal | null,
): Promise<Response> {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const abort = () => bridge.abort(id);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await bridge.request({
      id,
      url: request.url,
      method: request.method,
      headers: Array.from(request.headers.entries()),
      body,
    });
    if (signal?.aborted || (!result.success && result.aborted)) {
      throw new DOMException('请求已取消', 'AbortError');
    }
    if (!result.success) throw new Error(result.error);
    return new Response(request.method === 'HEAD' || [204, 205, 304].includes(result.status) ? null : result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
