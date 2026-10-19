// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.

import { parseApiKeys, type IProvider } from '@/lib/api-key-manager';

/** Custom services may run without authentication; built-in cloud presets still require a key. */
export function isProviderKeyOptional(
  provider: Pick<IProvider, 'platform' | 'apiKeyOptional'>,
): boolean {
  return provider.apiKeyOptional ?? (provider.platform === 'custom' || provider.platform === 'comfyui');
}

export function isProviderConfigured(provider: IProvider | null | undefined): boolean {
  if (!provider?.baseUrl?.trim()) return false;
  try {
    const url = new URL(provider.baseUrl.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  } catch {
    return false;
  }
  return parseApiKeys(provider.apiKey).length > 0 || isProviderKeyOptional(provider);
}

/** An unauthenticated request must omit Authorization instead of sending an empty Bearer token. */
export function getAuthorizationHeaders(apiKey?: string | null): Record<string, string> {
  const key = apiKey?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export const COMFYUI_VIDEO_UNSUPPORTED_MESSAGE =
  '当前版本尚未接入 ComfyUI 视频工作流，连接成功仅表示服务在线。请通过火宝生成视频，或使用兼容的视频 API。';

/** Recognize native ComfyUI configurations, including the existing Huobao workflow aliases. */
export function isComfyUIProvider(
  provider: Pick<IProvider, 'platform' | 'baseUrl'> & Partial<Pick<IProvider, 'model'>>,
): boolean {
  if (provider.platform === 'comfyui') return true;
  try {
    const url = new URL(provider.baseUrl);
    // An explicit versioned endpoint may belong to an OpenAI-compatible gateway.
    if (/\/v\d+(?:\/|$)/i.test(url.pathname)) return false;
    if (url.port === '8188' && !url.pathname.replace(/\/+$/, '')) return true;
  } catch {
    return false;
  }
  return provider.model?.some(model => /^huobao_(?:minimax_h3|wan22|qwen_image|z_image)(?:_|$)/i.test(model)) ?? false;
}
