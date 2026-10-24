// Shared AI provider core for Cloudflare Pages Functions and Netlify Functions.
// User-provided API keys are used only for the current request and are never persisted here.

const DEFAULT_ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DEFAULT_ZHIPU_MODEL = "glm-4-flash-250414";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODELS_URL = "https://api.deepseek.com/models";
const DEEPSEEK_MODEL = "deepseek-chat";
const MAX_BODY = 50000;
const MAX_KEY_LENGTH = 512;
const TOTAL_BUDGET_MS = 50000;
const FIRST_ATTEMPT_TIMEOUT_MS = 35000;
const CORRECTION_TIMEOUT_MS = 15000;
const VALIDATE_TIMEOUT_MS = 12000;

const clip = (value, limit = 800) => String(value || "").slice(0, limit);

export class AIRequestError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "AIRequestError";
    this.code = code;
    this.status = status;
  }
}

export function buildPrompt(type, payload = {}) {
  const system =
    "你是「AI 人生档案馆」的首席档案学者，也是一位阅历丰富的朋友。你从用户的真实人生片段出发，" +
    "输出有温度、具体、不空洞的分析与建议。所有输出使用简体中文。" +
    "必须只返回一个合法 JSON 对象，不要输出任何解释、前后缀或 Markdown 代码块。";

  switch (type) {
    case "analyze":
      return {
        system,
        user:
          `请分析这段人生片段：\n` +
          `日期：${payload.date || ""}\n` +
          `事件：${clip(payload.event)}\n` +
          `感受：${clip(payload.feeling) || "（未填写）"}\n` +
          `收获：${clip(payload.gain) || "（未填写）"}\n` +
          `\n严格按此 JSON 格式返回：{"keywords":["3到5个关键词"],"growth":"120字以内的成长分析","advice":"100字以内的人生建议"}`,
      };

    case "review": {
      const items = (payload.items || [])
        .map((item) => `- ${item.date || ""} 事件：${clip(item.event)} 收获：${clip(item.gain) || "无"}`)
        .join("\n");
      return {
        system,
        user:
          `请回顾 ${payload.yearMonth || ""} 这一个月的 ${(payload.items || []).length} 条人生记录：\n` +
          `${items}\n` +
          `\n严格按此 JSON 格式返回：{"summary":"120字以内的月度回顾","keywords":["3到5个关键词"],"growth":"120字以内的成长分析","advice":"100字以内的人生建议"}`,
      };
    }

    case "link":
      return {
        system,
        user:
          `请在两段相隔的人生记忆之间寻找隐秘的联系：\n` +
          `记忆A（${payload.a?.date || ""}）：${clip(payload.a?.event)}；感受：${clip(payload.a?.feeling) || "无"}；收获：${clip(payload.a?.gain) || "无"}\n` +
          `记忆B（${payload.b?.date || ""}）：${clip(payload.b?.event)}；感受：${clip(payload.b?.feeling) || "无"}；收获：${clip(payload.b?.gain) || "无"}\n` +
          `\n严格按此 JSON 格式返回：{"theme":"一句话概括共同主题","connection":"200字以内的连线解读，把两段记忆的关联讲清楚"}`,
      };

    case "letter":
      return {
        system,
        user:
          `这是一封写给未来的信，写于 ${payload.createdDate || "过去"}，设定在 ${payload.unlockDate || ""} 开启：\n` +
          `「${clip(payload.text, 1500)}」\n` +
          `\n请以「现在的你」的身份，给打开这封信的人写一段回望与回应。` +
          `严格按此 JSON 格式返回：{"reply":"200字以内的回信"}`,
      };

    case "failure": {
      const items = (payload.items || [])
        .map(
          (item) =>
            `- ${item.date || ""} 事件：${clip(item.event)} 感受：${clip(item.feeling) || "无"} ` +
            `收获：${clip(item.gain) || "无"} 标签：${(item.tags || []).join("、") || "无"}`,
        )
        .join("\n");
      return {
        system,
        user:
          `请复盘 ${payload.periodType === "year" ? payload.period + " 年" : payload.period + " 月"}的 ${(payload.items || []).length} 条「挫折」记录：\n` +
          `${items}\n` +
          `\n把相似的问题归成 3~6 个类别。严格按此 JSON 返回：{"summary":"120字以内的整体复盘","categories":[{"name":"类别名","count":数字,"insight":"80字以内的洞察"}],"advice":"100字以内的改进建议"}`,
      };
    }

    default:
      return null;
  }
}

function escapeControlCharsInStrings(text) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString) {
      if (escaped) {
        result += char;
        escaped = false;
      } else if (char === "\\") {
        result += char;
        escaped = true;
      } else if (char === '"') {
        result += char;
        inString = false;
      } else if (char.codePointAt(0) < 0x20) {
        if (char === "\n") result += "\\n";
        else if (char === "\r") result += "\\r";
        else if (char === "\t") result += "\\t";
        else result += "\\u" + char.codePointAt(0).toString(16).padStart(4, "0");
      } else {
        result += char;
      }
    } else {
      result += char;
      if (char === '"') inString = true;
    }
  }
  return result;
}

function removeTrailingCommas(text) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    result += char;
  }
  return result;
}

function extractBalancedObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function parseCandidate(candidate) {
  const variants = [candidate, removeTrailingCommas(candidate), escapeControlCharsInStrings(candidate)];
  if (variants[1] !== variants[0]) variants.push(escapeControlCharsInStrings(variants[1]));

  for (const variant of variants) {
    try {
      const value = JSON.parse(variant);
      if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) {
        return value;
      }
    } catch {
      // Try the next safe repair variant.
    }
  }
  return null;
}

export function parseJson(text) {
  const normalized = String(text || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const direct = parseCandidate(normalized);
  if (direct) return direct;

  for (const candidate of extractBalancedObjects(normalized)) {
    const parsed = parseCandidate(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function providerConfig(provider, env) {
  if (provider === "deepseek") {
    return {
      label: "DeepSeek",
      url: DEEPSEEK_BASE_URL,
      model: DEEPSEEK_MODEL,
      keyEnv: "",
    };
  }
  return {
    label: "智谱 GLM",
    url: env.ZHIPU_BASE_URL || DEFAULT_ZHIPU_BASE_URL,
    model: env.ZHIPU_MODEL || DEFAULT_ZHIPU_MODEL,
    keyEnv: env.ZHIPU_API_KEY || "",
  };
}

function sanitizeProviderKey(rawKey) {
  const key = String(rawKey || "").trim();
  if (!key) {
    throw new AIRequestError("missing_key", "请先填写 DeepSeek API Key", 401);
  }
  if (key.length > MAX_KEY_LENGTH || /[\r\n]/.test(key)) {
    throw new AIRequestError("invalid_key", "DeepSeek API Key 格式不正确", 400);
  }
  return key;
}

function mappedProviderError(provider, status) {
  if (status === 401 || status === 403) {
    return new AIRequestError(
      provider === "deepseek" ? "invalid_key" : "provider_auth",
      provider === "deepseek" ? "DeepSeek API Key 无效或没有访问权限" : "自带模型认证失败，请联系管理员检查服务配置",
      401,
    );
  }
  if (status === 429) {
    return new AIRequestError("rate_limited", "AI 服务当前访问量较大，请稍后再试", 429);
  }
  if (status >= 500) {
    return new AIRequestError("provider_unavailable", "AI 服务暂时不可用，请稍后重试", 502);
  }
  return new AIRequestError("provider_error", "AI 服务拒绝了请求，请检查设置后重试", 502);
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError" || controller.signal.aborted) {
      throw new AIRequestError("timeout", "AI 响应超时，请稍后重试", 504);
    }
    throw new AIRequestError("network_error", "无法连接 AI 服务，请检查网络后重试", 502);
  } finally {
    clearTimeout(timer);
  }
}

function messageContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
  }
  return typeof content === "string" ? content : "";
}

async function requestCompletion({ provider, key, prompt, env, fetchImpl, timeoutMs, correction = false }) {
  const config = providerConfig(provider, env);
  const messages = [
    {
      role: "system",
      content: correction
        ? `${prompt.system}\n上一次回复未通过 JSON 校验。请重新完成原任务，只返回修正后的合法 JSON 对象。`
        : prompt.system,
    },
    {
      role: "user",
      content: correction ? `请重新完成以下任务，只输出 JSON：\n\n${prompt.user}` : prompt.user,
    },
  ];
  const payload = {
    model: config.model,
    messages,
    temperature: 0.7,
    max_tokens: 1500,
    response_format: { type: "json_object" },
  };
  if (provider === "builtin" && /^glm-4\.7(?:-|$)/.test(config.model)) {
    payload.thinking = { type: "disabled" };
  }

  const response = await fetchWithTimeout(
    fetchImpl,
    config.url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );

  if (!response.ok) throw mappedProviderError(provider, response.status);

  let data;
  try {
    data = await response.json();
  } catch {
    throw new AIRequestError("empty_response", "AI 返回了无法读取的内容，请重试", 502);
  }
  const content = messageContent(data);
  if (!content.trim()) {
    throw new AIRequestError("empty_response", "AI 没有返回内容，请重试", 502);
  }
  return content;
}

export async function validateDeepSeekKey(rawKey, fetchImpl = fetch) {
  const key = sanitizeProviderKey(rawKey);
  const response = await fetchWithTimeout(
    fetchImpl,
    DEEPSEEK_MODELS_URL,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    },
    VALIDATE_TIMEOUT_MS,
  );
  if (!response.ok) throw mappedProviderError("deepseek", response.status);
}

export async function generateAI({ provider = "builtin", type, payload, deepseekKey, env, fetchImpl = fetch }) {
  const prompt = buildPrompt(type, payload);
  if (!prompt) throw new AIRequestError("bad_request", "不支持的请求类型", 400);

  const config = providerConfig(provider, env);
  const key = provider === "deepseek" ? sanitizeProviderKey(deepseekKey) : config.keyEnv;
  if (!key) {
    throw new AIRequestError("builtin_unavailable", "自带模型暂未配置，请改用 DeepSeek API", 503);
  }

  const startedAt = Date.now();
  const firstTimeout = Math.min(FIRST_ATTEMPT_TIMEOUT_MS, TOTAL_BUDGET_MS);
  const firstContent = await requestCompletion({
    provider,
    key,
    prompt,
    env,
    fetchImpl,
    timeoutMs: firstTimeout,
  });
  let parsed = parseJson(firstContent);

  if (!parsed) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt) - 500;
    const correctionTimeout = Math.min(CORRECTION_TIMEOUT_MS, remaining);
    if (correctionTimeout >= 1000) {
      const correctedContent = await requestCompletion({
        provider,
        key,
        prompt,
        env,
        fetchImpl,
        timeoutMs: correctionTimeout,
        correction: true,
      });
      parsed = parseJson(correctedContent);
    }
  }

  if (!parsed) {
    throw new AIRequestError("invalid_json", "AI 未能返回有效结果，请重试或更换 AI 设置", 502);
  }
  return { provider, model: config.model, ...parsed };
}

async function readJsonBody(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY) {
    throw new AIRequestError("body_too_large", "请求内容过大", 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY) {
    throw new AIRequestError("body_too_large", "请求内容过大", 413);
  }
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not object");
    return body;
  } catch {
    throw new AIRequestError("bad_request", "请求体不是合法 JSON", 400);
  }
}

const responseJson = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export async function handleAIRequest({ request, env = {}, fetchImpl = fetch }) {
  let provider = "builtin";
  try {
    const body = await readJsonBody(request);
    provider = body.provider || "builtin";
    if (!["builtin", "deepseek"].includes(provider)) {
      throw new AIRequestError("bad_provider", "不支持的 AI 服务类型", 400);
    }

    const deepseekKey = request.headers.get("x-deepseek-key") || "";
    if (body.type === "validate") {
      if (provider === "deepseek") {
        await validateDeepSeekKey(deepseekKey, fetchImpl);
        return responseJson({
          ok: true,
          data: { provider, model: DEEPSEEK_MODEL },
        });
      }
      const builtinKey = env.ZHIPU_API_KEY || "";
      if (!builtinKey) {
        throw new AIRequestError("builtin_unavailable", "自带模型暂未配置，请改用 DeepSeek API", 503);
      }
      return responseJson({
        ok: true,
        data: { provider, model: env.ZHIPU_MODEL || DEFAULT_ZHIPU_MODEL },
      });
    }

    const data = await generateAI({
      provider,
      type: body.type,
      payload: body.payload || {},
      deepseekKey,
      env,
      fetchImpl,
    });
    return responseJson({ ok: true, data });
  } catch (error) {
    const known = error instanceof AIRequestError;
    return responseJson(
      {
        ok: false,
        provider,
        code: known ? error.code : "internal_error",
        error: known ? error.message : "AI 服务发生内部错误，请稍后重试",
      },
      known ? error.status : 500,
    );
  }
}
