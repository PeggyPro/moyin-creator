// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.

import { corsFetch } from '@/lib/cors-fetch';
import { readImageAsBase64 } from '@/lib/image-storage';
import { getAuthorizationHeaders, getComfyUIVideoModelKind } from '@/lib/provider-config';
import wanTemplate from './workflows/wan22-video.json';
import h3Template from './workflows/minimax-h3-video.json';

type Link = [string, number];
type WorkflowNode = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } };
export type ComfyUIWorkflow = Record<string, WorkflowNode>;
type VideoImage = { url: string; role: 'first_frame' | 'last_frame' };

export interface ComfyUIVideoOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  prompt: string;
  duration?: number;
  aspectRatio?: string;
  videoResolution?: string;
  images?: VideoImage[];
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
  enableAudio?: boolean;
}

type OutputFile = { filename: string; subfolder?: string; type?: string; format?: string };
type HistoryEntry = {
  outputs?: Record<string, Record<string, unknown>>;
  status?: { completed?: boolean; status_str?: string; messages?: Array<[string, Record<string, unknown>]> };
};

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 45 * 60 * 1000;

function abortError(): Error {
  return new DOMException('用户已取消', 'AbortError');
}

async function request(options: ComfyUIVideoOptions, path: string, init: RequestInit = {}): Promise<Response> {
  if (options.signal?.aborted) throw abortError();
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 60_000);
  try {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(getAuthorizationHeaders(options.apiKey))) headers.set(name, value);
    return await corsFetch(`${options.baseUrl.trim().replace(/\/+$/, '')}${path}`, {
      ...init, headers, signal: controller.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw abortError();
    if (controller.signal.aborted) throw new Error('ComfyUI 请求超时，请检查本地服务是否正常运行');
    throw new Error(`无法连接 ComfyUI（${new URL(options.baseUrl).host}），请确认服务已启动：${error instanceof Error ? error.message : '网络请求失败'}`);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

async function readJson(response: Response, operation: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid JSON object');
  } catch {
    throw new Error(`${operation}失败（HTTP ${response.status}）：服务返回了无效的 JSON 内容`);
  }
  if (!response.ok) {
    const details: string[] = [];
    if (data.error && typeof data.error === 'object') {
      const error = data.error as Record<string, unknown>;
      if (error.message) details.push(String(error.message));
      if (error.details) details.push(String(error.details));
    } else if (data.error) details.push(String(data.error));
    if (data.node_errors && typeof data.node_errors === 'object') {
      for (const [id, raw] of Object.entries(data.node_errors)) {
        const node = raw as { class_type?: string; errors?: Array<{ message?: string; details?: string }> };
        for (const error of node.errors || []) details.push(`${node.class_type || id}：${error.message || ''} ${error.details || ''}`.trim());
      }
    }
    throw new Error(`${operation}失败（HTTP ${response.status}）：${details.join('；') || String(data.message || '请检查模型、节点和工作流配置')}`);
  }
  return data;
}

function isLink(value: unknown, id: string, slot: number): value is Link {
  return Array.isArray(value) && value[0] === id && value[1] === slot;
}

/** Reviewed Huobao templates are bundled; no filesystem path or cloud API is required at runtime. */
export function buildComfyUIVideoWorkflow(options: ComfyUIVideoOptions): ComfyUIWorkflow {
  const kind = getComfyUIVideoModelKind(options.model);
  if (!kind) throw new Error(`尚未接入 ComfyUI 工作流：${options.model}，请选择 Wan 2.2 5B 或 MiniMax H3 Reference Turbo`);
  const workflow = JSON.parse(JSON.stringify(kind === 'wan' ? wanTemplate : h3Template)) as ComfyUIWorkflow;
  const duration = options.duration ?? 5;
  if (!Number.isFinite(duration) || duration < 1 || duration > 30) throw new Error('本地视频时长须在 1 到 30 秒之间');
  if (!options.prompt.trim()) throw new Error('请先填写视频提示词');
  const seed = Math.floor(Math.random() * 2 ** 48);
  const taskName = `moyin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  for (const node of Object.values(workflow)) {
    if (node.class_type === 'CLIPTextEncode' && !/负面|negative/i.test(node._meta?.title || '')) node.inputs.text = options.prompt;
    if (node.class_type === 'PrimitiveStringMultiline') node.inputs.value = options.prompt;
    if (node.class_type === 'KSampler') node.inputs.seed = seed;
    if (node.class_type === 'RandomNoise') node.inputs.noise_seed = seed;
    if (node.class_type === 'SaveVideo') node.inputs.filename_prefix = `video/moyin/${taskName}`;
    if (node.class_type === 'PrimitiveFloat' && /duration/i.test(node._meta?.title || '')) node.inputs.value = duration;
    if (node.class_type === 'Wan22ImageToVideoLatent') {
      const ratioParts = (options.aspectRatio || '16:9').match(/^(\d+):(\d+)$/);
      const ratio = ratioParts ? Number(ratioParts[1]) / Number(ratioParts[2]) : 16 / 9;
      if (!Number.isFinite(ratio) || ratio < 0.25 || ratio > 4) throw new Error('视频画幅比例无效');
      const shortSide = options.videoResolution === '1080p' ? 1088 : options.videoResolution === '720p' ? 736 : 480;
      node.inputs.width = ratio >= 1 ? Math.round(shortSide * ratio / 32) * 32 : shortSide;
      node.inputs.height = ratio >= 1 ? shortSide : Math.round(shortSide / ratio / 32) * 32;
      node.inputs.length = 1 + 4 * Math.max(1, Math.round(duration * 24 / 4));
    }
    if (node.class_type === 'ResolutionSelector') {
      const ratios: Record<string, string> = {
        '16:9': '16:9 (Widescreen)', '9:16': '9:16 (Portrait Widescreen)', '1:1': '1:1 (Square)',
        '4:3': '4:3 (Standard)', '3:4': '3:4 (Portrait Standard)', '21:9': '21:9 (Ultrawide)',
      };
      node.inputs.aspect_ratio = ratios[options.aspectRatio || '16:9'] || ratios['16:9'];
      if (options.videoResolution === '720p') node.inputs.megapixels = 1;
      if (options.videoResolution === '1080p') node.inputs.megapixels = 2;
    }
    if (node.class_type === 'CreateVideo' && options.enableAudio === false) delete node.inputs.audio;
  }
  return workflow;
}

async function readReference(url: string, options: ComfyUIVideoOptions, label: string): Promise<Blob> {
  let source = url;
  if (url.startsWith('local-image://') || url.startsWith('file://') || /^[a-z]:[\\/]/i.test(url)) {
    source = await readImageAsBase64(url) || '';
    if (!source) throw new Error(`${label}本地文件无法读取，请重新生成或上传`);
  }
  let response: Response;
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(source)) {
    if (source.length > MAX_IMAGE_BYTES * 4 / 3 + 256) throw new Error(`${label}超过 32MB`);
    response = await fetch(source);
  } else if (/^https?:\/\//i.test(source)) {
    response = await corsFetch(source, { signal: options.signal });
  } else {
    throw new Error(`${label}地址无效，请重新生成或上传图片`);
  }
  if (!response.ok) throw new Error(`${label}读取失败（HTTP ${response.status}），请重新生成或上传图片`);
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error(`${label}超过 32MB`);
  const blob = await response.blob();
  if (!blob.size || blob.size > MAX_IMAGE_BYTES) throw new Error(`${label}为空或超过 32MB`);
  // Check real signatures: expired hosts sometimes return HTML or their error PNG with HTTP 404.
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (!png && !jpeg && !webp) throw new Error(`${label}不是有效的 PNG、JPEG 或 WebP 图片`);
  return new Blob([blob], { type: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp' });
}

async function injectReferences(workflow: ComfyUIWorkflow, options: ComfyUIVideoOptions): Promise<void> {
  const images = options.images || [];
  const kind = getComfyUIVideoModelKind(options.model);
  if (images.some(image => image.role !== 'first_frame' && image.role !== 'last_frame')) throw new Error('本地工作流暂不支持此类图片参考');
  for (const role of ['first_frame', 'last_frame'] as const) {
    if (images.filter(image => image.role === role).length > 1) throw new Error('每次仅支持一张首帧和一张尾帧图片');
  }
  if (kind === 'wan' && images.some(image => image.role === 'last_frame')) throw new Error('Wan 2.2 5B 仅支持首帧；首尾帧控制请切换 MiniMax H3 Reference Turbo');
  const blobs = await Promise.all(images.map(image => readReference(image.url, options, image.role === 'last_frame' ? '尾帧图片' : '首帧图片')));
  for (let index = 0; index < images.length; index++) {
    if (options.signal?.aborted) throw abortError();
    const form = new FormData();
    const extension = blobs[index].type === 'image/jpeg' ? 'jpg' : blobs[index].type === 'image/webp' ? 'webp' : 'png';
    form.append('image', blobs[index], `moyin_${Date.now()}_${index}.${extension}`);
    form.append('type', 'input');
    form.append('subfolder', 'moyin/refs');
    const uploaded = await readJson(await request(options, '/upload/image', { method: 'POST', body: form }), '上传 ComfyUI 参考图片');
    if (typeof uploaded.name !== 'string' || !uploaded.name || /[\\/]/.test(uploaded.name) || uploaded.type !== 'input') throw new Error('ComfyUI 返回了无效的上传图片名称');
    const filename = [uploaded.subfolder, uploaded.name].filter(Boolean).join('/').replace(/\\/g, '/');
    if (filename.startsWith('/') || filename.split('/').includes('..')) throw new Error('ComfyUI 返回了无效的图片路径');
    const nodeId = `moyin_reference_${index}`;
    workflow[nodeId] = { class_type: 'LoadImage', inputs: { image: filename } };
    if (kind === 'wan') {
      for (const node of Object.values(workflow)) if (node.class_type === 'Wan22ImageToVideoLatent') node.inputs.start_image = [nodeId, 0];
    } else {
      const root = Object.entries(workflow).find(([, node]) => node.class_type === 'MiniMaxH3ReferenceToVideo');
      if (!root) throw new Error('H3 工作流缺少首尾帧控制节点');
      const [rootId, rootNode] = root;
      const previousId = index === 0 ? rootId : `moyin_guide_${index - 1}`;
      const consumers = Object.values(workflow).flatMap(node => Object.entries(node.inputs)
        .filter(([, value]) => isLink(value, previousId, 0)).map(([key]) => ({ node, key })));
      const guideId = `moyin_guide_${index}`;
      workflow[guideId] = { class_type: 'MiniMaxH3AddGuide', inputs: {
        positive: [previousId, 0], latent: [rootId, 1], vae: rootNode.inputs.vae,
        image: [nodeId, 0], frame_idx: images[index].role === 'last_frame' ? -1 : 0,
      } };
      for (const { node, key } of consumers) node.inputs[key] = [guideId, 0];
    }
  }
}

function findVideo(entry: HistoryEntry): OutputFile | undefined {
  for (const output of Object.values(entry.outputs || {})) {
    for (const [key, value] of Object.entries(output)) {
      if (!['videos', 'gifs', 'images'].includes(key) || !Array.isArray(value)) continue;
      for (const file of value as OutputFile[]) {
        if (typeof file?.filename === 'string' && /\.(mp4|webm|mov|mkv)$/i.test(file.filename)) return file;
      }
    }
  }
  return undefined;
}

function waitForPoll(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, POLL_INTERVAL_MS);
    const abort = () => { clearTimeout(timer); cleanup(); reject(abortError()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Cancel only our prompt. Targeted interruption is supported by the installed ComfyUI 0.41.2+. */
async function cancelPrompt(options: ComfyUIVideoOptions, promptId: string, targetedInterrupt: boolean): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  const cleanupOptions = { ...options, signal: controller.signal };
  const send = (path: string, body: object) => request(cleanupOptions, path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => undefined);
  try {
    await Promise.all([
      send('/queue', { delete: [promptId] }),
      ...(targetedInterrupt ? [send('/interrupt', { prompt_id: promptId })] : []),
    ]);
  } finally { clearTimeout(timeout); }
}

/** Native /prompt → /history/{id} → /view. Never submits cloud requests or uses an external image host. */
export async function generateComfyUIVideo(options: ComfyUIVideoOptions): Promise<string> {
  let parsedUrl: URL;
  try { parsedUrl = new URL(options.baseUrl); } catch { throw new Error('ComfyUI 服务地址无效'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('ComfyUI 服务地址须使用 HTTP 或 HTTPS');
  if (options.signal?.aborted) throw abortError();
  const workflow = buildComfyUIVideoWorkflow(options);
  options.onProgress?.(0);
  const service = await readJson(await request(options, '/system_stats'), '读取 ComfyUI 服务状态');
  const system = service.system as { comfyui_version?: string } | undefined;
  if (!system || !Array.isArray(service.devices)) throw new Error('所选地址不是有效的 ComfyUI 服务');
  const version = String(system.comfyui_version || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  const targetedInterrupt = !!version && (Number(version[1]) > 0 || Number(version[2]) > 41 || (Number(version[2]) === 41 && Number(version[3]) >= 2));
  await injectReferences(workflow, options);
  options.onProgress?.(10);
  const clientId = crypto.randomUUID();
  let promptId: string = clientId;
  try {
    // No automatic retry: a disconnected submit may already have queued GPU work.
    const result = await readJson(await request(options, '/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, prompt_id: clientId, client_id: clientId }),
    }), '提交 ComfyUI 视频工作流');
    if (typeof result.prompt_id !== 'string' || !result.prompt_id.trim()) throw new Error('ComfyUI 未返回 prompt_id，无法查询视频生成进度');
    promptId = result.prompt_id;
    const started = Date.now();
    while (Date.now() - started < MAX_WAIT_MS) {
      if (options.signal?.aborted) throw abortError();
      const data = await readJson(await request(options, `/history/${encodeURIComponent(promptId)}`), '查询 ComfyUI 视频状态');
      const entry = data[promptId] as HistoryEntry | undefined;
      if (entry) {
        if (entry.status?.status_str === 'error') {
          const failure = entry.status.messages?.find(([type]) => type === 'execution_error' || type === 'execution_interrupted');
          const detail = failure?.[1];
          throw new Error(`ComfyUI 视频生成失败：${String(detail?.exception_message || detail?.exception_type || '工作流执行失败，请检查模型和显存')}`);
        }
        const video = findVideo(entry);
        if (video) {
          const view = new URL(`${options.baseUrl.trim().replace(/\/+$/, '')}/view`);
          view.searchParams.set('filename', video.filename);
          view.searchParams.set('subfolder', video.subfolder || '');
          view.searchParams.set('type', video.type || 'output');
          options.onProgress?.(100);
          return view.toString();
        }
        if (entry.status?.completed || entry.status?.status_str === 'success') throw new Error('ComfyUI 工作流执行完成但没有保存视频，请检查 SaveVideo 输出');
      }
      options.onProgress?.(Math.min(95, 10 + Math.floor((Date.now() - started) / 1000 / 3)));
      await waitForPoll(options.signal);
    }
    throw new Error('ComfyUI 视频生成超时（45 分钟），任务可能仍在本地队列中，请检查 ComfyUI');
  } catch (error) {
    if (options.signal?.aborted) await cancelPrompt(options, promptId, targetedInterrupt);
    throw error;
  }
}
