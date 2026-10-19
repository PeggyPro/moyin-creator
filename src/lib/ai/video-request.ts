// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.

import { corsFetch } from '@/lib/cors-fetch';

export class VideoReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoReferenceError';
  }
}

/** Validate a reference before it can be sent to a paid video endpoint. */
export async function fetchVideoReference(
  url: string,
  label: string,
  signal?: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await corsFetch(url, { signal });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new VideoReferenceError(`${label}无法读取，请重新上传图片或检查图片链接`);
  }
  if (!response.ok) {
    const reason = [404, 410].includes(response.status) ? '已失效' : '无法访问';
    throw new VideoReferenceError(`${label}${reason}（HTTP ${response.status}），请重新生成或上传${label}`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (/text\/|application\/(?:json|xml)/i.test(contentType)) {
    throw new VideoReferenceError(`${label}链接返回的内容不是图片，请重新生成或上传${label}`);
  }
  return response;
}

/** Keep network failures actionable while retaining AbortError for cancellation. */
export async function requestVideoApi(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await corsFetch(url, init);
  } catch (error) {
    if (init?.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    const stage = (init?.method || 'GET').toUpperCase() === 'GET' ? '查询视频进度' : '提交视频任务';
    const host = new URL(url).origin;
    throw new Error(`${stage}失败：无法连接 ${host}，请检查视频服务地址、服务是否启动及网络连接`);
  }
}
