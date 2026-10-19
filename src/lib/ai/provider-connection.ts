// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.

import { classifyModelByName, parseApiKeys, type IProvider } from '@/lib/api-key-manager';
import { corsFetch } from '@/lib/cors-fetch';
import {
  COMFYUI_VIDEO_UNSUPPORTED_MESSAGE,
  getAuthorizationHeaders,
  isComfyUIProvider,
  isProviderConfigured,
} from '@/lib/provider-config';

export interface ProviderConnectionTestResult {
  success: boolean;
  message: string;
  warning?: string;
}

function endpoint(baseUrl: string, path: string): string {
  return /\/v\d+$/i.test(baseUrl) ? `${baseUrl}/${path}` : `${baseUrl}/v1/${path}`;
}

function httpFailure(status: number, hasKey: boolean): ProviderConnectionTestResult {
  if (status === 401 || status === 403) {
    return {
      success: false,
      message: hasKey
        ? `鉴权失败 (${status})，请检查 API Key 和访问权限`
        : `服务要求鉴权 (${status})，请填写 API Key，或确认本地服务已关闭鉴权`,
    };
  }
  return { success: false, message: `连接测试失败 (${status})，请检查 Base URL 和接口协议` };
}

/** Test the service's own protocol. This never submits a ComfyUI generation job. */
export async function testProviderConnection(provider: IProvider): Promise<ProviderConnectionTestResult> {
  if (!provider.baseUrl?.trim()) return { success: false, message: '请先配置 Base URL' };

  const baseUrl = provider.baseUrl.trim().replace(/\/+$/, '');
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol');
  } catch {
    return { success: false, message: 'Base URL 必须是有效的 HTTP 或 HTTPS 地址' };
  }

  if (!isProviderConfigured(provider)) return { success: false, message: '此供应商需要配置 API Key' };

  const apiKey = parseApiKeys(provider.apiKey)[0] || '';
  const headers = getAuthorizationHeaders(apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  const init = { headers, signal: controller.signal };

  try {
    if (isComfyUIProvider(provider)) {
      const response = await corsFetch(`${baseUrl}/system_stats`, { ...init, method: 'GET' });
      if (!response.ok) return httpFailure(response.status, !!apiKey);
      const data = await response.json().catch(() => null);
      if (!data?.system || typeof data.system !== 'object' || !Array.isArray(data.devices)) {
        return { success: false, message: '返回内容不是 ComfyUI 状态信息，请检查 Base URL' };
      }
      return {
        success: true,
        message: 'ComfyUI 服务连接成功',
        warning: COMFYUI_VIDEO_UNSUPPORTED_MESSAGE,
      };
    }

    if (provider.platform === 'runninghub') {
      const response = await corsFetch(`${baseUrl}/query`, {
        ...init,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ taskId: 'test-connection-check' }),
      });
      if (response.ok || response.status === 400 || response.status === 404) {
        return { success: true, message: '连接测试成功' };
      }
      return httpFailure(response.status, !!apiKey);
    }

    // A model-list request works for image/video providers too, without asking
    // their first model to answer a chat message or starting a generation task.
    const response = await corsFetch(endpoint(baseUrl, 'models'), { ...init, method: 'GET' });
    if (response.ok) {
      const data = await response.json().catch(() => null);
      const models = Array.isArray(data) ? data : data?.data;
      if (Array.isArray(models)) return { success: true, message: '服务连接成功（模型列表可访问）' };
    }
    if (response.status === 401 || response.status === 403) {
      return httpFailure(response.status, !!apiKey);
    }

    // Some text-only services omit /models. Keep their existing chat probe,
    // but never send chat requests to an image/video-only model.
    const model = provider.model?.find(name => classifyModelByName(name).includes('text'));
    if (!model) {
      return {
        success: false,
        message: response.ok
          ? '模型列表返回格式不兼容，请检查接口协议'
          : `模型列表接口不可用 (${response.status})；当前模型不能使用聊天接口测试`,
      };
    }
    const chatResponse = await corsFetch(endpoint(baseUrl, 'chat/completions'), {
      ...init,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 }),
    });
    if (!chatResponse.ok) return httpFailure(chatResponse.status, !!apiKey);
    const chatData = await chatResponse.json().catch(() => null);
    if (!Array.isArray(chatData?.choices)) {
      return { success: false, message: '返回内容不是兼容的聊天响应，请检查接口协议' };
    }
    return { success: true, message: '连接测试成功' };
  } catch {
    return {
      success: false,
      message: controller.signal.aborted
        ? '连接测试超时，请确认服务已启动且地址正确'
        : '连接测试失败，请检查服务地址、网络和接口协议',
    };
  } finally {
    clearTimeout(timeout);
  }
}
