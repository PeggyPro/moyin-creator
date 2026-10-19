// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.

import { corsFetch } from '@/lib/cors-fetch';
import { readImageAsBase64 } from '@/lib/image-storage';

/** The -all models are legacy gateway models with a different image_urls contract. */
export function isStandardGptImageModel(model: string): boolean {
  return /(?:^|[/:])gpt-image(?:-|$)/i.test(model) && !/-all(?:-|$)/i.test(model);
}

export function throwIfImageRequestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('用户已取消', 'AbortError');
}

export function waitForImageRequest(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfImageRequestAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('用户已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** GPT Image 2+ accepts custom sizes; older GPT Image models accept three sizes. */
export function getGptImageSize(
  model: string,
  aspectRatio: string,
  resolution = '1K',
  width?: number,
  height?: number,
): string {
  const [rw, rh] = aspectRatio.split(':').map(Number);
  const ratio = rw > 0 && rh > 0 && Number.isFinite(rw / rh) ? rw / rh : 1;
  const customSizes = /gpt-image-(?:[2-9]|\d{2,})(?:\D|$)/i.test(model);
  if (!customSizes) {
    if (width !== undefined || height !== undefined) {
      const explicit = `${width}x${height}`;
      if (!['1024x1024', '1536x1024', '1024x1536'].includes(explicit)) {
        throw new Error('该 GPT 图片模型只支持 1024x1024、1536x1024 或 1024x1536');
      }
      return explicit;
    }
    return ratio > 1 ? '1536x1024' : ratio < 1 ? '1024x1536' : '1024x1024';
  }
  if (ratio < 1 / 3 || ratio > 3) throw new Error('GPT 图片宽高比必须在 1:3 到 3:1 之间');

  if (width === undefined && height === undefined) {
    // Preserve the requested composition and resolution within the Images API limits.
    const scale = resolution.toUpperCase() === '4K' ? 4 : resolution.toUpperCase() === '2K' ? 2 : 1;
    width = Math.sqrt(1024 * 1024 * ratio) * scale;
    height = width / ratio;
    const limit = Math.min(1, 3840 / Math.max(width, height), Math.sqrt(8294400 / (width * height)));
    width = Math.floor(width * limit / 16) * 16;
    height = Math.floor(height * limit / 16) * 16;
  }
  if (!width || !height || !Number.isInteger(width) || !Number.isInteger(height)
    || width % 16 || height % 16 || Math.max(width, height) > 3840
    || width * height < 655360 || width * height > 8294400
    || width / height < 1 / 3 || width / height > 3) {
    throw new Error('GPT 图片尺寸无效：边长须为 16 的倍数且不超过 3840，总像素须在 655360 到 8294400 之间');
  }
  return `${width}x${height}`;
}

export function imageDataUrlToBlob(dataUrl: string): Blob {
  const match = dataUrl.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/i);
  if (!match) throw new Error('参考图片必须是有效的 base64 图片');
  const bytes = Uint8Array.from(atob(match[2].replace(/\s/g, '')), char => char.charCodeAt(0));
  return new Blob([bytes], { type: match[1] });
}

async function loadReferenceImage(source: string, signal?: AbortSignal): Promise<Blob> {
  throwIfImageRequestAborted(signal);
  let image = source;
  if (!/^(?:https?:|data:|blob:)/i.test(image)) {
    const dataUrl = await readImageAsBase64(image);
    throwIfImageRequestAborted(signal);
    if (!dataUrl) throw new Error('无法读取参考图片，请重新选择图片');
    image = dataUrl;
  }
  if (image.startsWith('data:')) return imageDataUrlToBlob(image);
  const response = await corsFetch(image, { signal });
  throwIfImageRequestAborted(signal);
  if (!response.ok) throw new Error(`参考图片下载失败 (${response.status})，请重新选择可用图片`);
  const blob = await response.blob();
  throwIfImageRequestAborted(signal);
  if (!blob.size || (blob.type && !/^image\//i.test(blob.type) && blob.type !== 'application/octet-stream')) {
    throw new Error('参考图片链接没有返回有效图片，请重新选择图片');
  }
  return blob;
}

/** No response_format: GPT Image always returns base64 and rejects that legacy parameter. */
export async function buildGptImageRequest(params: {
  model: string;
  prompt: string;
  aspectRatio: string;
  resolution?: string;
  width?: number;
  height?: number;
  referenceImages?: string[];
  signal?: AbortSignal;
}): Promise<{ path: string; headers: Record<string, string>; body: string | FormData }> {
  throwIfImageRequestAborted(params.signal);
  const size = getGptImageSize(params.model, params.aspectRatio, params.resolution, params.width, params.height);
  if (!params.referenceImages?.length) {
    return {
      path: 'images/generations',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: params.model, prompt: params.prompt, n: 1, size }),
    };
  }
  const form = new FormData();
  form.append('model', params.model);
  form.append('prompt', params.prompt);
  form.append('n', '1');
  form.append('size', size);
  for (let i = 0; i < params.referenceImages.length; i++) {
    const blob = await loadReferenceImage(params.referenceImages[i], params.signal);
    throwIfImageRequestAborted(params.signal);
    const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
    form.append('image[]', blob, `reference-${i + 1}.${extension}`);
  }
  // Let Request/FormData supply Content-Type with the matching multipart boundary.
  return { path: 'images/edits', headers: {}, body: form };
}

type ImagePayload = Record<string, unknown>;
type ChatImagePart = {
  type?: unknown;
  image_url?: { url?: unknown };
  image?: { url?: unknown };
  data?: unknown;
};
type ChatImageChoice = { message?: { content?: unknown } };

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return firstString(value[0]);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Handles standard Images API base64 plus existing gateway URL/chat/task envelopes. */
export function extractImageResult(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const data = payload as ImagePayload;
  if (typeof data.b64_json === 'string' && data.b64_json) {
    const encoded = data.b64_json.trim();
    if (encoded.startsWith('data:image/')) return encoded;
    const format = data.output_format || data.format;
    const mime = format === 'jpeg' || encoded.startsWith('/9j/') ? 'image/jpeg'
      : format === 'webp' || encoded.startsWith('UklGR') ? 'image/webp' : 'image/png';
    return `data:${mime};base64,${encoded}`;
  }
  const direct = firstString(data.url) || firstString(data.image_url) || firstString(data.output_url) || firstString(data.result_url);
  if (direct) return direct;
  for (const nested of [data.data, data.result, data.images, data.task_result]) {
    const first = Array.isArray(nested) ? nested[0] : nested;
    if (typeof first === 'string') return first;
    const image = extractImageResult(first);
    if (image) return image;
  }
  const choices = Array.isArray(data.choices) ? data.choices as ChatImageChoice[] : undefined;
  const content = choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    for (const value of content) {
      if (!value || typeof value !== 'object') continue;
      const part = value as ChatImagePart;
      const image = firstString(part.image_url?.url) || firstString(part.image?.url)
        || (part.type === 'image' && typeof part.data === 'string' && part.data ? `data:image/png;base64,${part.data}` : undefined);
      if (image) return image;
    }
  }
  if (typeof content === 'string') {
    return content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/)?.[1]
      || content.match(/(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/)?.[1]
      || content.match(/(https?:\/\/[^\s"']+\.(?:png|jpg|jpeg|webp|gif)[^\s"']*)/i)?.[1];
  }
  return undefined;
}
