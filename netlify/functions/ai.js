// AI 人生档案馆 · Netlify Function
// 与 Cloudflare Pages 版共用同一套模型路由和 JSON 容错逻辑。

import { handleAIRequest } from "../../functions/_shared/ai-core.js";

function env(name, fallback = "") {
  if (typeof Netlify !== "undefined" && Netlify.env && typeof Netlify.env.get === "function") {
    const value = Netlify.env.get(name);
    if (value) return value;
  }
  if (typeof process !== "undefined" && process.env) {
    return process.env[name] || fallback;
  }
  return fallback;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export default async (request) => {
  if (request.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed", error: "仅支持 POST 请求" }, 405);
  }
  return handleAIRequest({
    request,
    env: {
      ZHIPU_API_KEY: env("ZHIPU_API_KEY"),
      ZHIPU_MODEL: env("ZHIPU_MODEL"),
      ZHIPU_BASE_URL: env("ZHIPU_BASE_URL"),
    },
  });
};

export const config = {
  path: "/api/ai",
  method: ["POST"],
};
