// AI 人生档案馆 · Cloudflare Pages Function
// 统一转发自带智谱模型或请求头中携带的用户 DeepSeek Key。

import { handleAIRequest } from "../_shared/ai-core.js";

export async function onRequestPost(context) {
  return handleAIRequest({
    request: context.request,
    env: context.env || {},
  });
}
