"use strict";
// v-fix-y-var

/* ============================================================
   AI 人生档案馆 · 前端逻辑
   档案保存在浏览器本地；AI 走 /api/ai 云函数，可选择
   用户自己的 DeepSeek API 或网站自带的智谱 GLM。
   ============================================================ */

/* ---------------- 基础工具 ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const bindSafe = (el, evt, fn) => { if (el) el.addEventListener(evt, fn); };

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

const truncate = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
};

const REDUCED_MOTION = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const localDateStr = (d = new Date()) =>
  [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");

const parseDate = (s) => {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

const fmtCN = (s) => {
  const d = parseDate(s);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};

const daysUntil = (s) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = parseDate(s);
  return Math.round((target - today) / 86400000);
};

/* ---------------- 数据 ---------------- */
const KEYS = { moments: "archive.moments.v1", letters: "archive.letters.v1" };
const AI_SETTINGS_KEY = "archive.ai.settings.v1";
const AI_TIMEOUT_MS = 60000;
const AI_VALIDATE_TIMEOUT_MS = 15000;

const loadArr = (key) => {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

let moments = loadArr(KEYS.moments);
let letters = loadArr(KEYS.letters);

const saveMoments = () => localStorage.setItem(KEYS.moments, JSON.stringify(moments));
const saveLetters = () => localStorage.setItem(KEYS.letters, JSON.stringify(letters));

const normalizeAiSettings = (value) => {
  const provider = value?.provider === "deepseek" ? "deepseek" : "builtin";
  return {
    provider,
    deepseekKey: typeof value?.deepseekKey === "string" ? value.deepseekKey : "",
    updatedAt: typeof value?.updatedAt === "number" ? value.updatedAt : 0,
  };
};

const loadAiSettings = () => {
  try {
    return normalizeAiSettings(JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)));
  } catch {
    return normalizeAiSettings(null);
  }
};

let aiSettings = loadAiSettings();

function saveAiSettings(next) {
  aiSettings = normalizeAiSettings({ ...next, updatedAt: Date.now() });
  try {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(aiSettings));
    return true;
  } catch {
    showToast("AI 设置保存失败，请检查浏览器存储空间");
    return false;
  }
}

/* ---------------- IndexedDB 媒体存储 ---------------- */
const IDB_NAME = "ai-life-archive";
const IDB_STORE = "media";
const MAX_MEDIA = 3;
const MAX_IMAGE_MB = 10;
const MAX_VIDEO_MB = 100;

function idbOpen() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(IDB_NAME, 1);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbTx(mode, fn) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode);
    const store = tx.objectStore(IDB_STORE);
    const out = fn(store);
    tx.oncomplete = () => { db.close(); resolve(out); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error("abort")); };
  }));
}

const idbPutMedia = (id, blob, type, name) => idbTx("readwrite", (s) => s.put({ id, blob, type, name, at: Date.now() }));
const idbGetMedia = (id) => idbTx("readonly", (s) => new Promise((res, rej) => {
  const r = s.get(id);
  r.onsuccess = () => res(r.result || null);
  r.onerror = () => rej(r.error);
}));
const idbDeleteMedia = (ids) => idbTx("readwrite", (s) => (ids || []).forEach((id) => s.delete(id)));
const idbClearMedia = () => idbTx("readwrite", (s) => s.clear());
const idbCountMedia = () => idbTx("readonly", (s) => new Promise((res, rej) => {
  const r = s.count();
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
const idbAllMedia = () => idbTx("readonly", (s) => new Promise((res, rej) => {
  const r = s.getAll();
  r.onsuccess = () => res(r.result || []);
  r.onerror = () => rej(r.error);
}));

const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(fr.result);
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(blob);
});

const dataURLToBlob = async (dataUrl) => {
  const res = await fetch(dataUrl);
  return res.blob();
};

const MOODS = [
  { id: "joy", emoji: "😊", label: "开心" },
  { id: "happy", emoji: "😄", label: "愉快" },
  { id: "excited", emoji: "🎉", label: "兴奋" },
  { id: "proud", emoji: "😎", label: "自豪" },
  { id: "warm", emoji: "🥰", label: "温暖" },
  { id: "moved", emoji: "🥹", label: "感动" },
  { id: "grateful", emoji: "🙏", label: "感恩" },
  { id: "calm", emoji: "😌", label: "平静" },
  { id: "hopeful", emoji: "🤩", label: "期待" },
  { id: "think", emoji: "🤔", label: "思考" },
  { id: "nostalgic", emoji: "🌙", label: "怀念" },
  { id: "tired", emoji: "😪", label: "疲惫" },
  { id: "anxious", emoji: "😰", label: "焦虑" },
  { id: "lonely", emoji: "🥺", label: "孤单" },
  { id: "sad", emoji: "😢", label: "难过" },
  { id: "angry", emoji: "😤", label: "生气" },
];

const moodById = (id) => MOODS.find((m) => m.id === id) || MOODS[0];
const moodEmoji = (id) => moodById(id).emoji;
const moodLabel = (id) => moodById(id).label;

/* ---------------- 界面状态 ---------------- */
const ui = {
  year: null,
  tag: null,
  search: "",
  mood: "calm",
  editId: null,
  editFrom: "screen-archive",
  detailId: null,
  linkA: null,
  linkB: null,
  tags: [],
  tagSearch: "",
  timelineYear: null,
  pendingMedia: [],
  mediaUrls: [],
};

/* ---------------- 导航 ---------------- */
function showScreen(id, dir = "forward") {
  document.body.dataset.dir = dir;
  $$(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
  const el = document.getElementById(id);
  if (el) el.scrollTop = 0;
  window.scrollTo(0, 0);
}

/* ---------------- 时空穿梭进场动画 ---------------- */
function warpDustSpans() {
  const n = 16;
  return Array.from({ length: n }, () => {
    const angle = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 120;
    const sx = Math.round(Math.cos(angle) * dist);
    const sy = Math.round(Math.sin(angle) * dist);
    const sway = Math.round(Math.random() * 40 - 20);
    const ex = Math.round(sx * -0.75 + sway);
    const ey = Math.round(sy * -0.75);
    const size = (2 + Math.random() * 3).toFixed(1);
    const delay = (Math.random() * 0.6).toFixed(2);
    return `<span class="warp-dust" style="--sx:${sx}px;--sy:${sy}px;--ex:${ex}px;--ey:${ey}px;--sz:${size}px;animation-delay:${delay}s"></span>`;
  }).join("");
}

function startWarp() {
  if (REDUCED_MOTION) {
    $("#door-scene").classList.remove("opening");
    delete document.body.dataset.entering;
    showScreen("screen-archive", "forward");
    return;
  }
  const overlay = $("#warp-overlay");
  overlay.innerHTML = `
    <div class="warp-tunnel">
      <div class="warp-ring r1"></div>
      <div class="warp-ring r2"></div>
      <div class="warp-ring r3"></div>
      <div class="warp-ring r4"></div>
      <div class="warp-ring r5"></div>
    </div>
    <div class="warp-core"></div>
    <div class="warp-dust-layer">${warpDustSpans()}</div>
    <div class="warp-awake"></div>`;
  overlay.classList.add("active");
  setTimeout(() => {
    overlay.classList.remove("active");
    $("#door-scene").classList.remove("opening");
    delete document.body.dataset.entering;
    showScreen("screen-archive", "awake");
  }, 1250);
}

/* ---------------- Toast ---------------- */
let toastTimer = null;
function showToast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------------- 复古弹窗 ---------------- */
let modalLastFocus = null;

function showModal(message, title = "还差一点", focusBack = null) {
  modalLastFocus = focusBack || document.activeElement;
  $("#modal-message").textContent = message;
  $("#modal-title").textContent = title;
  const overlay = $("#modal-overlay");
  overlay.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add("show")));
  $("#modal-ok").focus();
}

function closeModal() {
  const overlay = $("#modal-overlay");
  if (overlay.hidden) return;
  overlay.classList.remove("show");
  setTimeout(() => { overlay.hidden = true; }, 260);
  if (modalLastFocus && modalLastFocus.focus) modalLastFocus.focus();
}

/* ---------------- AI 服务选择 ---------------- */
let aiSetupDismissible = true;
let aiSetupReturnFocus = null;
let aiValidationBusy = false;

function renderAiSettingsSummary() {
  const current = $("#ai-current-provider");
  const clearButton = $("#btn-clear-deepseek-key");
  const hint = $("#ai-settings-hint");
  if (current) {
    current.textContent = aiSettings.provider === "deepseek"
      ? "自己的 DeepSeek · deepseek-chat"
      : "档案馆自带智谱 GLM · 可能不稳定";
  }
  if (clearButton) clearButton.hidden = !aiSettings.deepseekKey;
  if (hint) {
    hint.textContent = aiSettings.deepseekKey
      ? "DeepSeek Key 只保存在当前浏览器中，不随档案备份导出。"
      : "尚未保存 DeepSeek Key；可随时打开 AI 设置填写。";
  }
}

function setAiSetupError(message) {
  const error = $("#ai-setup-error");
  if (!error) return;
  error.textContent = message || "";
  error.hidden = !message;
}

function setAiChoice(provider) {
  $("#ai-choice-deepseek")?.classList.toggle("selected", provider === "deepseek");
  $("#ai-choice-builtin")?.classList.toggle("selected", provider === "builtin");
}

function setAiSetupBusy(busy) {
  aiValidationBusy = busy;
  const input = $("#f-deepseek-key");
  const confirm = $("#btn-deepseek-confirm");
  const builtin = $("#btn-use-builtin");
  const close = $("#ai-setup-close");
  if (input) input.disabled = busy;
  if (confirm) {
    confirm.disabled = busy;
    confirm.textContent = busy ? "验证中…" : "确定";
  }
  if (builtin) builtin.disabled = busy;
  if (close) close.disabled = busy;
}

function openAiSetup({ dismissible = true } = {}) {
  const overlay = $("#ai-setup-overlay");
  if (!overlay) return;
  aiSetupDismissible = dismissible;
  aiSetupReturnFocus = document.activeElement;
  setAiSetupError("");
  setAiSetupBusy(false);
  setAiChoice(aiSettings.provider);
  const input = $("#f-deepseek-key");
  if (input) input.value = aiSettings.deepseekKey || "";
  const close = $("#ai-setup-close");
  if (close) close.hidden = !dismissible;
  overlay.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add("show")));
  setTimeout(() => {
    if (aiSettings.provider === "deepseek" && input) input.focus();
    else $("#btn-use-builtin")?.focus();
  }, 80);
}

function closeAiSetup() {
  if (!aiSetupDismissible || aiValidationBusy) return;
  const overlay = $("#ai-setup-overlay");
  if (!overlay || overlay.hidden) return;
  overlay.classList.remove("show");
  setTimeout(() => { overlay.hidden = true; }, 260);
  if (aiSetupReturnFocus && aiSetupReturnFocus.focus) aiSetupReturnFocus.focus();
}

async function confirmDeepSeekKey() {
  if (aiValidationBusy) return;
  const input = $("#f-deepseek-key");
  const key = input ? input.value.trim() : "";
  if (!key) {
    setAiSetupError("请先填写 DeepSeek API Key，或选择使用自带模型。");
    input?.focus();
    return;
  }

  setAiSetupError("");
  setAiSetupBusy(true);
  const result = await requestAI(
    { provider: "deepseek", type: "validate", payload: {} },
    { deepseekKey: key, timeoutMs: AI_VALIDATE_TIMEOUT_MS },
  );
  if (!result.ok) {
    setAiSetupBusy(false);
    setAiSetupError(result.error || "DeepSeek Key 验证失败，请检查后重试。");
    input?.focus();
    return;
  }

  if (!saveAiSettings({ provider: "deepseek", deepseekKey: key })) {
    setAiSetupBusy(false);
    setAiSetupError("设置无法保存，请检查浏览器是否允许本地存储。");
    return;
  }
  setAiSetupBusy(false);
  setAiChoice("deepseek");
  renderAiSettingsSummary();
  aiSetupDismissible = true;
  closeAiSetup();
  showToast("已启用自己的 DeepSeek API");
}

function useBuiltinAI() {
  if (aiValidationBusy) return;
  if (!saveAiSettings({ provider: "builtin", deepseekKey: aiSettings.deepseekKey })) return;
  setAiChoice("builtin");
  renderAiSettingsSummary();
  aiSetupDismissible = true;
  closeAiSetup();
  showToast("已选择自带智谱模型");
}

function clearDeepSeekKey() {
  if (!aiSettings.deepseekKey) return;
  if (!confirm("确定清除当前浏览器保存的 DeepSeek API Key 吗？")) return;
  if (!saveAiSettings({ provider: "builtin", deepseekKey: "" })) return;
  renderAiSettingsSummary();
  showToast("DeepSeek Key 已清除");
}

/* ---------------- 档案室 ---------------- */
function topTags(list, n = 3) {
  const counts = {};
  list.forEach((m) => (m.tags || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map((x) => x[0]);
}

function renderArchive() {
  const years = [...new Set(moments.map((m) => String(m.date).slice(0, 4)))].sort().reverse();

  $("#archive-stats").innerHTML = `
    <div class="stat"><b>${moments.length}</b><span>人生片段</span></div>
    <div class="stat"><b>${years.length}</b><span>档案年份</span></div>
    <div class="stat"><b>${letters.length}</b><span>时间胶囊</span></div>`;

  const grid = $("#year-grid");
  if (!years.length) {
    grid.innerHTML = `<div class="empty">档案室还空着。<br>点击右下角「记录此刻」，开启你的第一份档案。</div>`;
    return;
  }

  grid.innerHTML = years.map((y, i) => {
    const ys = moments.filter((m) => String(m.date).slice(0, 4) === y);
    const tags = topTags(ys, 3);
    return `
      <button class="year-card" type="button" data-year="${esc(y)}" style="--i:${i % 8}">
        <span class="year-num">${esc(y)}</span>
        <span class="year-count">${ys.length} 份档案</span>
        ${tags.length ? `<span class="year-tags">${tags.map(esc).join(" · ")}</span>` : ""}
      </button>`;
  }).join("");
}

function openYear(year) {
  ui.year = year;
  ui.tag = null;
  ui.search = "";
  $("#search-input").value = "";
  $("#year-title").textContent = `${year} 年 · 时间轴`;
  const yearTlLabel = $("#year-timeline-label");
  if (yearTlLabel) yearTlLabel.textContent = `${year} 年时间轴`;
  renderYear();
  showScreen("screen-year", "forward");
  setTimeout(observeTimeline, 150); // 等屏幕可见后再触发浮现动画，避免进入时时间轴空白
}

function visibleMoments() {
  return moments
    .filter((m) => !ui.year || String(m.date).slice(0, 4) === ui.year)
    .filter((m) => !ui.tag || (m.tags || []).includes(ui.tag))
    .filter((m) => {
      if (!ui.search) return true;
      const hay = `${m.event} ${m.feeling} ${m.gain} ${(m.tags || []).join(" ")}`.toLowerCase();
      return hay.includes(ui.search.toLowerCase());
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.createdAt || 0) - (a.createdAt || 0));
}

function renderYear() {
  const yearMoments = moments.filter((m) => String(m.date).slice(0, 4) === ui.year);
  const tagCounts = {};
  yearMoments.forEach((m) => (m.tags || []).forEach((t) => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
  const tags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map((x) => x[0]);

  $("#tag-chips").innerHTML = [
    `<button class="tag-chip ${ui.tag ? "" : "active"}" type="button" data-tag="">全部</button>`,
    ...tags.map((t) =>
      `<button class="tag-chip ${ui.tag === t ? "active" : ""}" type="button" data-tag="${esc(t)}">${esc(t)} (${tagCounts[t]})</button>`),
  ].join("");

  const list = visibleMoments();
  const tl = $("#timeline");
  if (!list.length) {
    tl.innerHTML = `<div class="empty">${yearMoments.length ? "没有找到匹配的档案。" : `这一年的档案柜还是空的。<br>点击「记录」，为 ${esc(ui.year)} 留下第一段记忆。`}</div>`;
    return;
  }

  tl.innerHTML = list.map((m, i) => `
    <div class="l-item" style="--i:${Math.min(i, 12)}">
      <article class="card" data-moment-id="${esc(m.id)}">${cardInnerHTML(m)}</article>
    </div>`).join("");
  hydrateMediaThumbs();

}

function typeBadgeHTML(type) {
  if (type === "setback") return `<span class="type-badge setback">挫折</span>`;
  if (type === "success") return `<span class="type-badge success">成功</span>`;
  return "";
}

function mediaThumbHTML(m) {
  const first = (m.media || []).find((x) => x.type === "image");
  return first ? `<span class="card-thumb" data-media-img="${esc(first.id)}"></span>` : "";
}

async function hydrateMediaThumbs() {
  const els = $$("[data-media-img]");
  for (const el of els) {
    const rec = await idbGetMedia(el.dataset.mediaImg).catch(() => null);
    if (rec && rec.type === "image") {
      el.style.backgroundImage = `url("${URL.createObjectURL(rec.blob)}")`;
    }
  }
}

function cardInnerHTML(m) {
  return `
    <div class="card-head">
      <time>${esc(m.date)}</time>
      <span class="card-head-right">${typeBadgeHTML(m.type)}<span class="mood" title="${esc(moodLabel(m.mood))}">${moodEmoji(m.mood)}</span></span>
    </div>
    <h3>${esc(m.event)}</h3>
    ${mediaThumbHTML(m)}
    ${m.feeling ? `<p class="snippet">感受：${esc(truncate(m.feeling, 46))}</p>` : ""}
    ${m.gain ? `<p class="snippet gain">收获：${esc(truncate(m.gain, 46))}</p>` : ""}
    ${(m.tags || []).length ? `<div class="mini-tags">${m.tags.map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}`;
}

function openAllTimeline(dir = "forward", year) {
  if (year !== undefined) ui.timelineYear = year;
  ui.tag = null;
  ui.search = "";
  $("#all-timeline-title").textContent = ui.timelineYear ? `${ui.timelineYear} 年 · 时间轴` : "全部时间轴";
  const backBtn = $("#screen-all-timeline [data-back]");
  if (backBtn) backBtn.dataset.back = ui.timelineYear ? "screen-year" : "screen-archive";
  const wrap = $("#tz-v");
  if (wrap) wrap.classList.remove("draw"); // 每次进入都先藏起时间轴，等书翻完再浮现
  renderAllTimeline();
  showScreen("screen-all-timeline", dir);
  if (dir === "forward") startBookIntro();
  else finishTimelineReveal();
}

const TZ_NODE_H = 150;

function renderAllTimeline() {
  const sorted = [...moments].sort(
    (a, b) => String(a.date).localeCompare(String(b.date)) || (a.createdAt || 0) - (b.createdAt || 0),
  ).filter((m) => !ui.timelineYear || String(m.date).slice(0, 4) === ui.timelineYear);
  const wrap = $("#tz-v");
  const nodesEl = $("#tz-nodes");
  const svg = $("#tz-svg");
  const width = wrap.clientWidth || window.innerWidth || 800;
  if (!sorted.length) {
    wrap.style.height = "320px";
    nodesEl.innerHTML = `<div class="empty">时间轴还是空的。<br>点击「记录此刻」，留下你的第一段记忆。</div>`;
    svg.innerHTML = "";
    return;
  }
  const count = sorted.length;
  const totalH = count * TZ_NODE_H + 100;
  wrap.style.height = totalH + "px";
  const dotX = (i) => Math.round(width * (i % 2 === 0 ? 0.35 : 0.65));
  const dotY = (i) => totalH - 50 - i * TZ_NODE_H - TZ_NODE_H / 2;

  const isYearMode = !ui.timelineYear;
  const groupKey = (m) => (isYearMode ? String(m.date).slice(0, 4) : String(m.date).slice(5, 7));
  const groupLabel = (k) => (isYearMode ? k : `${parseInt(k, 10)}月`);
  let lastGroup = null;
  const groupMarkers = [];
  const nodesHtml = sorted.map((m, i) => {
    const g = groupKey(m);
    const y = String(m.date).slice(0, 4);
    if (lastGroup === null) {
      // 第一个分组（年份/月份）：在轴起点（首条事件下方的引线末端）按黄铜点
      groupMarkers.push(`
        <div class="tz-year-marker" style="left:${dotX(0)}px;top:${dotY(0) + 40}px;--di:0">
          <span class="tz-year-knob"></span>
          <span class="tz-year-label">${esc(groupLabel(g))}</span>
        </div>`);
    } else if (g !== lastGroup) {
      // 在分组交界处的折线中点上，按一个黄铜点
      groupMarkers.push(`
        <div class="tz-year-marker" style="left:${Math.round((dotX(i - 1) + dotX(i)) / 2)}px;top:${Math.round((dotY(i - 1) + dotY(i)) / 2)}px;--di:${i}">
          <span class="tz-year-knob"></span>
          <span class="tz-year-label">${esc(groupLabel(g))}</span>
        </div>`);
    }
    lastGroup = g;
    return `
    <div class="tz-node ${i % 2 === 0 ? "even" : "odd"}" style="top:${dotY(i) - 60}px;--di:${i}">
      <div class="tz-dot"></div>
      <article class="tz-card" data-moment-id="${esc(m.id)}">
        <div class="card-head">
          <span class="tz-year">${esc(y)}</span>
          <span class="card-head-right">${typeBadgeHTML(m.type)}<span class="mood" title="${esc(moodLabel(m.mood))}">${moodEmoji(m.mood)}</span></span>
        </div>
        <time class="tz-day" title="${esc(m.date)}">${esc(m.date.slice(5))}</time>
        <h3>${esc(truncate(m.event, 12))}</h3>
        ${mediaThumbHTML(m)}
      </article>
    </div>`;
  }).join("");
  nodesEl.innerHTML = nodesHtml + groupMarkers.join("");
  hydrateMediaThumbs();

  svg.setAttribute("width", width);
  svg.setAttribute("height", totalH);
  const pts = [`${dotX(0)},${dotY(0) + 40}`]; // 轴起点：第一条事件下方的小段引线，供首个黄铜点落点
  for (let i = 0; i < count; i++) pts.push(`${dotX(i)},${dotY(i)}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="tzGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#d3ab57"/>
        <stop offset="1" stop-color="#b98a2f"/>
      </linearGradient>
    </defs>
    <path class="tz-line" d="M ${pts.join(" L ")}" pathLength="1"/>`;
}

function finishTimelineReveal() {
  const wrap = $("#tz-v");
  if (!wrap) return;
  setTimeout(() => wrap.classList.add("draw"), 30); // 稍等一帧，让浮现动画正常播放
}

function startBookIntro() {
  if (REDUCED_MOTION) {
    finishTimelineReveal();
    return;
  }
  const book = $("#book-overlay");
  book.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => book.classList.add("active")));
  setTimeout(() => finishTimelineReveal(), 2400); // 书翻完、光柱升起后，时间轴才慢慢浮现
  setTimeout(() => {
    book.classList.remove("active");
    setTimeout(() => { book.hidden = true; }, 520);
  }, 3300);
}

function jumpToDetail(id) {
  const ov = $("#jump-overlay");
  ov.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add("active")));
  setTimeout(() => {
    ov.classList.remove("active");
    setTimeout(() => { ov.hidden = true; }, 360);
    openDetail(id, "awake");
  }, 440);
}

function rerenderYear() {
  renderYear();
  setTimeout(observeTimeline, 0);
}

const tObserver = typeof IntersectionObserver === "undefined"
  ? null
  : new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          en.target.classList.add("in-view");
          tObserver.unobserve(en.target);
        }
      });
    }, { threshold: 0.08 });

function observeTimeline(scope = "#timeline") {
  const vh = window.innerHeight || document.documentElement.clientHeight;
  $$(`${scope} .t-item, ${scope} .l-item`).forEach((el) => {
    if (el.classList.contains("in-view")) return;
    if (!tObserver) {
      el.classList.add("in-view"); // 老内核不支持观察器时直接全部显示
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.top < vh - 20 && r.bottom > 0) {
      el.classList.add("in-view"); // 已在视口内，直接显示
    } else {
      tObserver.observe(el); // 在视口下方，滚动到时再浮现
    }
  });
}

/* ---------------- 卡片详情 ---------------- */
function openDetail(id, dir = "forward") {
  const m = moments.find((x) => x.id === id);
  if (!m) return;
  ui.detailId = id;
  ui.linkA = id;
  const active = document.querySelector(".screen.active");
  const from = active && active.id === "screen-all-timeline" ? "screen-all-timeline" : "screen-year";
  const backBtn = $("#screen-detail [data-back]");
  if (backBtn) backBtn.dataset.back = from;
  renderDetail(m);
  showScreen("screen-detail", dir);
}

function renderDetail(m) {
  const ai = m.ai;
  $("#detail-body").innerHTML = `
    <div class="detail-card">
      <div class="detail-head">
        <div>
          <time>${esc(fmtCN(m.date))}</time>
          ${typeBadgeHTML(m.type)}
        </div>
        <span class="mood-big" title="${esc(moodLabel(m.mood))}">${moodEmoji(m.mood)}</span>
      </div>
      <h2 class="detail-event">${esc(m.event)}</h2>
      <div class="detail-sec">
        <h4>感 受</h4>
        <p>${esc(m.feeling || "（未填写）")}</p>
      </div>
      <div class="detail-sec">
        <h4>收 获</h4>
        <p>${esc(m.gain || "（未填写）")}</p>
      </div>
      ${(m.tags || []).length ? `<div class="detail-sec"><h4>标 签</h4><div class="mini-tags">${m.tags.map((t) => `<span>${esc(t)}</span>`).join("")}</div></div>` : ""}
      <div id="detail-media" class="detail-media"></div>
    </div>

    <div class="ai-zone">
      <div class="ai-zone-head">
        <span class="stamp">档案馆批注</span>
        <button class="btn-ghost" id="btn-analyze" type="button">${ai ? "重新解读" : "请 AI 解读"}</button>
      </div>
      <div id="ai-result">
        ${ai ? aiResultHTML(ai) : `<p class="hint">AI 将为你提炼关键词、分析成长，并送上一段人生建议。</p>`}
      </div>
    </div>`;
  renderDetailMedia(m);
}

async function renderDetailMedia(m) {
  const box = $("#detail-media");
  if (!box) return;
  box.innerHTML = "";
  if (!m.media || !m.media.length) return;
  for (const item of m.media) {
    const rec = await idbGetMedia(item.id).catch(() => null);
    const wrap = document.createElement("div");
    wrap.className = "detail-media-item";
    if (rec) {
      const url = URL.createObjectURL(rec.blob);
      if (item.type === "image") {
        const img = document.createElement("img");
        img.src = url;
        img.alt = item.name || "档案图片";
        wrap.appendChild(img);
      } else {
        const v = document.createElement("video");
        v.src = url;
        v.controls = true;
        v.preload = "metadata";
        wrap.appendChild(v);
      }
    } else {
      wrap.innerHTML = `<span class="media-fallback">媒体文件缺失（可能已被浏览器清理）</span>`;
    }
    box.appendChild(wrap);
  }
}

function aiSourceLabel(value = {}) {
  if (value.provider === "deepseek") {
    return `DeepSeek · ${value.model || "deepseek-chat"}`;
  }
  if (value.provider === "builtin" || value.source === "ai") {
    return `智谱 GLM · ${value.model || "glm-4-flash-250414"}`;
  }
  if (value.source === "demo") return "演示结果（旧数据）";
  return "AI 结果";
}

function aiResultHTML(ai) {
  return `
    <div class="ai-card">
      <div class="ai-keywords">
        <span class="lbl">关键词</span>
        ${(ai.keywords || []).map((k) => `<span class="kw">${esc(k)}</span>`).join("")}
      </div>
      <div class="ai-block"><span class="lbl">成长分析</span><p>${esc(ai.growth)}</p></div>
      <div class="ai-block"><span class="lbl">人生建议</span><p>${esc(ai.advice)}</p></div>
      <span class="ai-source">${esc(aiSourceLabel(ai))}</span>
    </div>`;
}

/* ---------------- 记录 / 编辑 ---------------- */
function renderMoodSelect(sel) {
  $("#f-mood").innerHTML = MOODS.map((m) =>
    `<option value="${m.id}" ${m.id === sel ? "selected" : ""}>${m.emoji} ${m.label}</option>`).join("");
}

/* ---------------- 标签选择器 ---------------- */
const DEFAULT_TAGS = ["考试", "学习", "朋友", "家人", "旅行", "成长", "第一次", "大学", "比赛", "阅读", "运动", "美食", "离别", "相遇", "假期", "反思"];
const MAX_TAGS = 10;
const MAX_POOL_TAGS = 25;

function tagPool() {
  const counts = {};
  moments.forEach((m) => (m.tags || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  const byFreq = Object.entries(counts).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  // 最常用的标签排最前（超出 25 时从底部裁掉，常用标签不受影响）
  return [...new Set([...byFreq, ...DEFAULT_TAGS, ...ui.tags])];
}

function renderTagOptions() {
  const raw = (ui.tagSearch || "").trim();
  const q = raw.toLowerCase();
  const pool = tagPool().filter((t) => !q || t.toLowerCase().includes(q));
  if (q && !pool.length) {
    $("#tag-options").innerHTML = `
      <div class="tag-notfound">
        <p>没有找到「${esc(raw)}」这个标签</p>
        <button class="btn-primary" type="button" id="btn-add-search-tag">＋ 直接添加为新标签</button>
        <button class="btn-ghost" type="button" id="btn-goto-other">去「其他」里填写</button>
      </div>`;
    return;
  }
  const hint = !q && pool.length > MAX_POOL_TAGS
    ? `<p class="tag-more-hint">共 ${pool.length} 个标签，显示最常用的 ${MAX_POOL_TAGS} 个，可搜索查找</p>`
    : "";
  const html = hint + pool.slice(0, MAX_POOL_TAGS).map((t) =>
    `<button class="tag-option ${ui.tags.includes(t) ? "sel" : ""}" type="button" data-pick-tag="${esc(t)}">${esc(t)}</button>`).join("");
  $("#tag-options").innerHTML = html || `<p class="hint" style="margin:6px 2px">没有匹配的标签，可在下方「其他」中填写</p>`;
}

function syncTagOptions() {
  $$("#tag-options .tag-option").forEach((r) =>
    r.classList.toggle("sel", ui.tags.includes(r.dataset.pickTag)));
}

function updateTagChips() {
  const chips = $("#tag-chosen");
  const summary = $("#tag-summary");
  if (!ui.tags.length) {
    chips.innerHTML = "";
    summary.textContent = "点击选择标签…";
    return;
  }
  chips.innerHTML = ui.tags.map((t) =>
    `<span class="tag-chip chosen" data-remove-tag="${esc(t)}">${esc(t)} ✕</span>`).join("");
  summary.textContent = `已选 ${ui.tags.length}/${MAX_TAGS} 个标签`;
}

function toggleTag(t) {
  const i = ui.tags.indexOf(t);
  if (i >= 0) {
    ui.tags.splice(i, 1);
  } else {
    if (ui.tags.length >= MAX_TAGS) {
      showToast(`每条记录最多选择 ${MAX_TAGS} 个标签，请先移除一个`);
      return;
    }
    ui.tags.push(t);
  }
  syncTagOptions();
  updateTagChips();
}

function removeTag(t) {
  const i = ui.tags.indexOf(t);
  if (i >= 0) {
    ui.tags.splice(i, 1);
    syncTagOptions();
    updateTagChips();
  }
}

function addTagsFromText(text) {
  const parts = String(text || "").split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { added: 0, ignored: 0, empty: true };
  const fresh = parts.filter((p) => !ui.tags.includes(p));
  const remaining = MAX_TAGS - ui.tags.length;
  if (remaining <= 0) {
    showToast(`每条记录最多选择 ${MAX_TAGS} 个标签，请先移除一个`);
    return { added: 0, ignored: 0, blocked: true };
  }
  const added = fresh.slice(0, remaining);
  const ignored = fresh.length - added.length;
  added.forEach((p) => ui.tags.push(p));
  renderTagOptions();
  updateTagChips();
  if (ignored > 0) showToast(`最多 ${MAX_TAGS} 个标签，已保留前 ${ui.tags.length} 个，其余被忽略`);
  else if (added.length) showToast(`已添加 ${added.length} 个标签`);
  else showToast("这些标签已在列表中");
  return { added: added.length, ignored };
}

function addOtherTags() {
  const input = $("#tag-other-input");
  const r = addTagsFromText(input.value);
  if (r.empty) showToast("请先填写标签内容");
  if (!r.blocked && !r.empty) input.value = "";
}

function toggleTagPanel() {
  const panel = $("#tag-panel");
  panel.hidden = !panel.hidden;
  $("#tag-picker").classList.toggle("open", !panel.hidden);
}

function closeTagPanel() {
  const panel = $("#tag-panel");
  if (!panel.hidden) {
    panel.hidden = true;
    $("#tag-picker").classList.remove("open");
  }
}

/* ---------------- 媒体上传 ---------------- */
function compressImage(file, maxSide = 1600, quality = 0.75) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      const outType = file.type === "image/png" ? "image/webp" : "image/jpeg";
      canvas.toBlob((b) => resolve(b || file), outType, quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file);
    };
    img.src = url;
  });
}

async function handleMediaFiles(files) {
  try {
  const list = Array.from(files || []);
  const room = MAX_MEDIA - ui.pendingMedia.length;
  if (room <= 0) {
    showToast(`最多添加 ${MAX_MEDIA} 个图片/视频`);
    return;
  }
  let added = 0;
  for (const f of list) {
    if (added >= room) {
      showToast(`最多 ${MAX_MEDIA} 个，多余的已忽略`);
      break;
    }
    const isImg = f.type.startsWith("image/");
    const isVid = f.type.startsWith("video/");
    if (!isImg && !isVid) {
      showToast("仅支持图片或视频文件");
      continue;
    }
    if (isVid && f.size > MAX_VIDEO_MB * 1024 * 1024) {
      showToast(`视频不能超过 ${MAX_VIDEO_MB}MB`);
      continue;
    }
    if (isImg && f.size > MAX_IMAGE_MB * 1024 * 1024) {
      showToast(`图片不能超过 ${MAX_IMAGE_MB}MB`);
      continue;
    }
    const id = uid();
    const blob = isImg ? await compressImage(f) : f;
    ui.pendingMedia.push({
      id,
      type: isImg ? "image" : "video",
      name: f.name,
      size: blob.size,
      blob,
    });
    added += 1;
  }
    renderMediaPreview();
  } catch (err) {
    console.error("媒体处理失败", err);
    showToast(`媒体处理失败：${err && err.message ? err.message : "未知错误"}，请重试或换一张图片`);
  }
}

/* ---------------- 媒体上传前的风险确认 ---------------- */
let pendingMediaFiles = null;

function showMediaWarn(files) {
  try {
    const overlay = $("#media-warn-overlay");
    if (!overlay || !$("#media-warn-ok")) throw new Error("modal missing");
    pendingMediaFiles = files;
    overlay.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add("show")));
    setTimeout(() => $("#media-warn-ok").focus(), 60);
  } catch {
    // 弹窗不可用（旧缓存页面）时直接进入上传流程，避免上传失效
    handleMediaFiles(files);
  }
}

function hideMediaWarn() {
  const overlay = $("#media-warn-overlay");
  if (!overlay || overlay.hidden) return;
  overlay.classList.remove("show");
  setTimeout(() => { overlay.hidden = true; }, 260);
}

function confirmMediaWarn() {
  hideMediaWarn();
  if (pendingMediaFiles && pendingMediaFiles.length) {
    handleMediaFiles(pendingMediaFiles);
  }
  pendingMediaFiles = null;
}

function cancelMediaWarn() {
  hideMediaWarn();
  pendingMediaFiles = null;
}

function renderMediaPreview() {
  const box = $("#media-preview");
  if (!box) return;
  (ui.mediaUrls || []).forEach((u) => URL.revokeObjectURL(u));
  ui.mediaUrls = [];
  box.innerHTML = "";
  ui.pendingMedia.forEach((item) => {
    const wrap = document.createElement("div");
    wrap.className = "media-item";
    const url = URL.createObjectURL(item.blob);
    ui.mediaUrls.push(url);
    if (item.type === "image") {
      const img = document.createElement("img");
      img.src = url;
      wrap.appendChild(img);
    } else {
      const v = document.createElement("video");
      v.src = url;
      v.muted = true;
      v.controls = true;
      v.preload = "metadata";
      wrap.appendChild(v);
    }
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "media-remove";
    rm.textContent = "✕";
    rm.dataset.mediaId = item.id;
    wrap.appendChild(rm);
    box.appendChild(wrap);
  });
}

function removePendingMedia(id) {
  const i = ui.pendingMedia.findIndex((x) => x.id === id);
  if (i >= 0) ui.pendingMedia.splice(i, 1);
  renderMediaPreview();
}

async function persistMedia(oldMedia, pending) {
  const oldIds = (oldMedia || []).map((x) => x.id).filter(Boolean);
  const newIds = pending.map((x) => x.id);
  const remove = oldIds.filter((id) => !newIds.includes(id));
  if (remove.length) await idbDeleteMedia(remove).catch(() => {});
  for (const item of pending) {
    await idbPutMedia(item.id, item.blob, item.type, item.name).catch(() => {});
  }
}

/* ---------------- AI 解读开关（兼容写法，不依赖 :has） ---------------- */
function syncAiToggle() {
  const check = $("#f-ai-now");
  const box = check ? check.closest(".ai-toggle") : null;
  if (box) box.classList.toggle("on", check.checked);
}

async function openEdit(id, fromScreen = "screen-archive") {
  ui.editId = id || null;
  ui.editFrom = fromScreen;
  const m = id ? moments.find((x) => x.id === id) : null;

  $("#edit-title").textContent = m ? "编辑档案" : "记录此刻";
  $("#f-event").value = m ? m.event : "";
  $("#f-date").value = m ? m.date : localDateStr();
  $("#f-feeling").value = m ? m.feeling || "" : "";
  $("#f-gain").value = m ? m.gain || "" : "";
  ui.tags = m ? [...(m.tags || [])] : [];
  ui.tagSearch = "";
  $("#tag-search").value = "";
  closeTagPanel();
  renderTagOptions();
  updateTagChips();
  $("#f-ai-now").checked = m ? Boolean(m.ai) : true;
  syncAiToggle();

  renderMoodSelect(m && MOODS.some((x) => x.id === m.mood) ? m.mood : "calm");
  $("#f-type").value = m && ["success", "normal", "setback"].includes(m.type) ? m.type : "normal";

  ui.pendingMedia = [];
  if (m && Array.isArray(m.media) && m.media.length) {
    for (const item of m.media) {
      const rec = await idbGetMedia(item.id).catch(() => null);
      if (rec) {
        ui.pendingMedia.push({
          id: item.id,
          type: item.type === "video" ? "video" : "image",
          name: item.name || "",
          size: rec.blob.size,
          blob: rec.blob,
        });
      }
    }
  }
  renderMediaPreview();

  const back = $("#screen-edit [data-back]");
  back.dataset.back = m ? "screen-detail" : fromScreen;

  showScreen("screen-edit", "forward");
  $("#f-event").focus();
}

async function saveMoment(e) {
  e.preventDefault();
  const event = $("#f-event").value.trim();
  if (!event) {
    showModal("事件是档案的起点。先写下发生了什么，我们才能帮你把这份记忆收进档案馆。", "还差一点", $("#f-event"));
    return;
  }

  const type = $("#f-type").value || "normal";
  const media = ui.pendingMedia.map((x) => ({ id: x.id, type: x.type, name: x.name, size: x.size }));
  const data = {
    event,
    date: $("#f-date").value || localDateStr(),
    mood: $("#f-mood").value || "calm",
    feeling: $("#f-feeling").value.trim(),
    gain: $("#f-gain").value.trim(),
    tags: [...ui.tags].slice(0, 10),
    type,
    media,
  };

  if (ui.editId) {
    const m = moments.find((x) => x.id === ui.editId);
    if (m) {
      await persistMedia(m.media || [], ui.pendingMedia);
      Object.assign(m, data);
      m.updatedAt = Date.now();
      m.ai = null; // 内容变了，旧解读作废
    }
  } else {
    const id = uid();
    await persistMedia([], ui.pendingMedia);
    moments.unshift({ id, createdAt: Date.now(), ...data });
  }
  ui.pendingMedia = [];

  const wantAI = $("#f-ai-now").checked;
  const savedId = ui.editId || moments[0].id;
  saveMoments();
  showToast(wantAI ? "档案已保存，AI 解读生成中…" : "档案已保存");

      if (ui.editId) {
        showScreen("screen-detail", "back");
        renderDetail(moments.find((x) => x.id === ui.editId));
      } else {
        if (ui.editFrom === "screen-year") {
          rerenderYear();
          showScreen("screen-year", "back");
        } else if (ui.editFrom === "screen-link") {
          showScreen("screen-link", "back");
          openLinkScreen();
        } else if (ui.editFrom === "screen-all-timeline") {
          showScreen("screen-all-timeline", "back");
          openAllTimeline("back");
        } else {
          renderArchive();
          showScreen("screen-archive", "back");
    }
  }

  if (wantAI) {
    generateAnalysis(moments.find((x) => x.id === savedId)).then((res) => {
      const onDetail = document.querySelector("#screen-detail.active");
      if (res && res.source === "error") {
        if (!onDetail) showToast("AI 解读生成失败，可在卡片里重试");
        return;
      }
      if (!onDetail) showToast("AI 解读已生成");
    });
  }
}

async function deleteCurrentMoment() {
  const m = moments.find((x) => x.id === ui.detailId);
  if (!m) return;
  if (!confirm(`确定删除「${m.event}」这份档案吗？删除后无法恢复。`)) return;
  moments = moments.filter((x) => x.id !== ui.detailId);
  await idbDeleteMedia((m.media || []).map((x) => x.id)).catch(() => {});
  saveMoments();
  showToast("档案已删除");
  showScreen("screen-year", "back");
  rerenderYear();
}

/* ---------------- AI 调用 ---------------- */
async function requestAI(body, { deepseekKey = "", timeoutMs = AI_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { "Content-Type": "application/json" };
  if (body.provider === "deepseek" && deepseekKey) {
    headers["X-DeepSeek-Key"] = deepseekKey;
  }

  let response;
  try {
    response = await fetch("/api/ai", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    return {
      ok: false,
      provider: body.provider,
      code: controller.signal.aborted ? "timeout" : "network_error",
      error: controller.signal.aborted
        ? "AI 响应超时，请稍后重试或更换 AI 设置"
        : "网络连接失败，请检查网络后重试",
    };
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  } finally {
    clearTimeout(timer);
  }
  if (controller.signal.aborted) {
    return {
      ok: false,
      provider: body.provider,
      code: "timeout",
      error: "AI 响应超时，请稍后重试或更换 AI 设置",
    };
  }
  if (data?.ok) return { ok: true, ...data.data };
  return {
    ok: false,
    provider: data?.provider || body.provider,
    code: data?.code || "bad_response",
    error: data?.error || "AI 服务返回了无法读取的结果，请稍后重试",
  };
}

async function callAI(type, payload) {
  if (aiSettings.provider === "deepseek" && !aiSettings.deepseekKey) {
    return {
      source: "error",
      provider: "deepseek",
      code: "missing_key",
      error: "尚未保存 DeepSeek API Key，请先打开 AI 设置填写",
    };
  }
  const result = await requestAI(
    { provider: aiSettings.provider, type, payload },
    { deepseekKey: aiSettings.deepseekKey },
  );
  return result.ok
    ? { source: "ai", ...result }
    : {
        source: "error",
        provider: result.provider,
        code: result.code,
        error: result.error,
      };
}

function aiErrorHTML(message, retryId) {
  return `
    <div class="ai-error">
      <span class="stamp">档案馆提示</span>
      <p>${esc(message)}</p>
      <div class="ai-error-actions">
        <button class="btn-ghost" type="button" id="${esc(retryId)}">再试一次</button>
        <button class="btn-ghost" type="button" data-open-ai-settings>更换 AI 设置</button>
      </div>
    </div>`;
}

async function generateAnalysis(m) {
  if (!m) return null;
  const res = await callAI("analyze", {
    date: m.date,
    event: m.event,
    feeling: m.feeling,
    gain: m.gain,
    moodLabel: moodLabel(m.mood),
  });
  const fresh = moments.find((x) => x.id === m.id);
  if (!fresh) return res;
  if (res.source === "error") return res;
  fresh.ai = {
    keywords: res.keywords || [],
    growth: res.growth || "",
    advice: res.advice || "",
    source: res.source,
    provider: res.provider || aiSettings.provider,
    model: res.model || "",
    at: Date.now(),
  };
  saveMoments();
  if (ui.detailId === fresh.id && document.querySelector("#screen-detail.active")) {
    renderDetail(fresh);
  }
  return res;
}

async function analyzeMoment(m) {
  const resultEl = $("#ai-result");
  const btn = $("#btn-analyze");
  if (!resultEl || !btn) return;

  btn.disabled = true;
  btn.textContent = "AI 思考中…";
  resultEl.innerHTML = `<div class="ai-loading"><span class="stamp">研读中</span>档案馆正在整理你的这段记忆…</div>`;

  const res = await generateAnalysis(m);
  if (res && res.source === "error") {
    resultEl.innerHTML = aiErrorHTML(res.error || "AI 服务暂时繁忙，请稍后重试", "btn-analyze-retry");
    btn.disabled = false;
    btn.textContent = "重新解读";
    return;
  }
  const fresh = moments.find((x) => x.id === m.id);
  if (fresh) renderDetail(fresh);
}

async function runReview() {
  const month = $("#review-month").value.trim();
  const resultEl = $("#review-result");
  const btn = $("#btn-review-run");
  if (!/^\d{4}-\d{2}$/.test(month)) {
    showToast("请选择或填写 YYYY-MM 格式的月份");
    return;
  }
  const items = moments
    .filter((m) => String(m.date).startsWith(month))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!items.length) {
    showToast("这个月还没有档案");
    return;
  }

  btn.disabled = true;
  btn.textContent = "AI 思考中…";
  resultEl.innerHTML = `<div class="ai-loading"><span class="stamp">研读中</span>档案馆正在翻阅这一个月的记录…</div>`;

  const res = await callAI("review", {
    yearMonth: month,
    items: items.map((m) => ({ date: m.date, event: m.event, feeling: m.feeling, gain: m.gain })),
  });

  if (res.source === "error") {
    resultEl.innerHTML = aiErrorHTML(res.error || "AI 服务暂时繁忙，请稍后重试", "btn-review-retry");
    btn.disabled = false;
    btn.textContent = "生成回顾";
    return;
  }

  resultEl.innerHTML = `
    <div class="ai-card">
      <span class="stamp">月度回顾</span>
      <div class="ai-block"><span class="lbl">这个月</span><p>${esc(res.summary)}</p></div>
      <div class="ai-keywords">${(res.keywords || []).map((k) => `<span class="kw">${esc(k)}</span>`).join("")}</div>
      <div class="ai-block"><span class="lbl">成长分析</span><p>${esc(res.growth)}</p></div>
      <div class="ai-block"><span class="lbl">人生建议</span><p>${esc(res.advice)}</p></div>
      <span class="ai-source">${esc(aiSourceLabel(res))}</span>
    </div>`;
  btn.disabled = false;
  btn.textContent = "重新生成";
}

/* ---------------- 失败复盘 ---------------- */
function updateFailPeriodInputs() {
  const scope = $("#fail-scope").value;
  $("#fail-period-month").hidden = scope !== "month";
  $("#fail-period-year").hidden = scope !== "year";
}

function failPeriod() {
  const scope = $("#fail-scope").value;
  return { scope, period: scope === "year" ? String($("#fail-period-year").value || "") : $("#fail-period-month").value };
}

function setbackItems(periodType, period) {
  return moments
    .filter((m) => m.type === "setback")
    .filter((m) => (periodType === "year" ? String(m.date).slice(0, 4) === period : String(m.date).startsWith(period)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function runFailureStats() {
  const box = $("#fail-stats");
  if (!box) return;
  const { scope, period } = failPeriod();
  if (!period) {
    showToast("请先选择月份或年份");
    return;
  }
  const items = setbackItems(scope, period);
  if (!items.length) {
    box.innerHTML = `<div class="empty">这个${scope === "year" ? "年" : "月"}还没有标记为「挫折」的记录。<br>记录时在「类型」里选「挫折」，或编辑旧档案补标。</div>`;
    return;
  }
  const counts = {};
  items.forEach((m) => (m.tags || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = top.length ? top[0][1] : 1;
  box.innerHTML = `
    <div class="fail-stats">
      <div class="stat-row"><b>${items.length}</b> 条挫折记录 · 涉及 ${top.length} 个分类</div>
      ${top.map(([t, c]) => `
        <div class="bar-row">
          <span class="bar-label" title="${esc(t)}">${esc(t)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.round((c / max) * 100)}%"></div></div>
          <span class="bar-count">${c}</span>
        </div>`).join("")}
    </div>`;
}

async function runFailureAI() {
  const resultEl = $("#fail-result");
  const btn = $("#btn-fail-ai");
  if (!resultEl || !btn) return;
  const { scope, period } = failPeriod();
  if (!period) {
    showToast("请先选择月份或年份");
    return;
  }
  const items = setbackItems(scope, period);
  if (!items.length) {
    showToast("这个时段没有「挫折」记录，先标记一些再复盘");
    return;
  }
  btn.disabled = true;
  btn.textContent = "AI 思考中…";
  resultEl.innerHTML = `<div class="ai-loading"><span class="stamp">复盘</span>档案馆正在翻阅这些挫折记录…</div>`;
  const res = await callAI("failure", {
    periodType: scope,
    period,
    items: items.map((m) => ({ date: m.date, event: m.event, feeling: m.feeling, gain: m.gain, tags: m.tags || [] })),
  });
  if (res.source === "error") {
    resultEl.innerHTML = aiErrorHTML(res.error || "AI 服务暂时繁忙，请稍后重试", "btn-fail-ai-retry");
    btn.disabled = false;
    btn.textContent = "AI 失败复盘";
    return;
  }
  resultEl.innerHTML = failureResultHTML(res);
  btn.disabled = false;
  btn.textContent = "重新生成";
}

function failureResultHTML(res) {
  const cats = (res.categories || []).map((c) => `
    <div class="ai-block"><span class="lbl">${esc(c.name)} · ${Number(c.count) || 0} 次</span><p>${esc(c.insight || "")}</p></div>`).join("");
  return `
    <div class="ai-card">
      <span class="stamp">失败复盘</span>
      <div class="ai-block"><span class="lbl">整体复盘</span><p>${esc(res.summary || "")}</p></div>
      ${cats}
      <div class="ai-block"><span class="lbl">改进建议</span><p>${esc(res.advice || "")}</p></div>
      <span class="ai-source">${esc(aiSourceLabel(res))}</span>
    </div>`;
}

async function runLink() {
  const a = moments.find((x) => x.id === ui.linkA);
  const b = moments.find((x) => x.id === ui.linkB);
  const resultEl = $("#link-result");
  const btn = $("#btn-link-run");
  if (moments.length < 2) {
    if (resultEl) {
      resultEl.innerHTML = `<div class="empty">时空连线需要至少 2 段档案。<br>先去「记录此刻」留下两段记忆，再来连线吧。</div>`;
    }
    return;
  }
  if (!a || !b) {
    showToast("请选择两段记忆");
    return;
  }
  if (a.id === b.id) {
    showToast("请选择两段不同的记忆");
    return;
  }

  btn.disabled = true;
  btn.textContent = "AI 思考中…";
  resultEl.innerHTML = `<div class="ai-loading"><span class="stamp">连线中</span>档案馆正在两段记忆之间寻找线索…</div>`;

  const res = await callAI("link", {
    a: { date: a.date, event: a.event, feeling: a.feeling, gain: a.gain },
    b: { date: b.date, event: b.event, feeling: b.feeling, gain: b.gain },
  });

  if (res.source === "error") {
    resultEl.innerHTML = aiErrorHTML(res.error || "AI 服务暂时繁忙，请稍后重试", "btn-link-retry");
    btn.disabled = false;
    btn.textContent = "开始连线";
    return;
  }

  resultEl.innerHTML = `
    <div class="link-line">
      <span class="link-node" title="${esc(fmtCN(a.date))}">${esc(truncate(a.event, 10))}</span>
      <span class="link-thread"></span>
      <span class="link-node" title="${esc(fmtCN(b.date))}">${esc(truncate(b.event, 10))}</span>
    </div>
    <div class="ai-card">
      <span class="stamp">时空连线</span>
      <div class="ai-block"><span class="lbl">共同主题</span><p>${esc(res.theme)}</p></div>
      <div class="ai-block"><span class="lbl">连线解读</span><p>${esc(res.connection)}</p></div>
      <span class="ai-source">${esc(aiSourceLabel(res))}</span>
    </div>`;
  btn.disabled = false;
  btn.textContent = "重新连线";
}

/* ---------------- 时间胶囊 ---------------- */
function renderVault() {
  const list = $("#letter-list");
  if (!letters.length) {
    list.innerHTML = `<div class="empty">时间胶囊是空的。<br>写一封信，让未来的某个时刻收到现在的你。</div>`;
    return;
  }

  const sorted = [...letters].sort((a, b) => String(a.unlockDate).localeCompare(String(b.unlockDate)));
  list.innerHTML = sorted.map((l) => {
    const locked = daysUntil(l.unlockDate) > 0;
    return `
      <div class="letter-card ${locked ? "locked" : ""}">
        <div class="letter-head">
          <span class="envelope">${locked ? "📜" : "💌"}</span>
          <div>
            <h3>${locked ? "密封中" : "已解锁"}</h3>
            <p>${locked
              ? `将于 ${fmtCN(l.unlockDate)} 开启 · 还剩 ${daysUntil(l.unlockDate)} 天`
              : `开启于 ${fmtCN(l.unlockDate)}`}</p>
          </div>
        </div>
        ${locked ? "" : `
          <div class="letter-body">
            <p>${esc(l.text)}</p>
            ${l.aiReply
              ? `<div class="ai-block"><span class="lbl">AI 回信</span><p>${esc(l.aiReply)}</p></div>`
              : `<button class="btn-ghost" type="button" data-letter-ai="${esc(l.id)}">请 AI 回信</button>`}
          </div>`}
      </div>`;
  }).join("");
}

function saveLetter(e) {
  e.preventDefault();
  const text = $("#f-letter-text").value.trim();
  const date = $("#f-letter-date").value;
  if (!text) {
    showModal("这封信还是空的。写点什么再密封吧，未来的你会想收到你的声音。", "还差一点", $("#f-letter-text"));
    return;
  }
  if (!date || daysUntil(date) < 1) {
    showToast("请选择未来的拆信日期");
    return;
  }
  letters.push({ id: uid(), text, unlockDate: date, createdAt: Date.now() });
  saveLetters();
  $("#f-letter-text").value = "";
  $("#f-letter-date").value = "";
  renderVault();
  showScreen("screen-vault", "back");
  showToast("信已密封，交给时间");
}

async function letterAIReply(id) {
  const l = letters.find((x) => x.id === id);
  if (!l) return;
  const btn = $(`[data-letter-ai="${id}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "AI 回信中…";
  }
  const res = await callAI("letter", { text: l.text, unlockDate: l.unlockDate, createdDate: fmtCN(l.createdAt ? localDateStr(new Date(l.createdAt)) : "") });
  if (res.source === "error") {
    showToast(res.error || "AI 暂时没有回应，请稍后重试");
    renderVault();
    return;
  }
  l.aiReply = res.reply || "（AI 暂时没有回应，请稍后再试）";
  saveLetters();
  renderVault();
}

/* ---------------- 数据管理 ---------------- */
async function exportData() {
  const mediaMap = {};
  const all = await idbAllMedia().catch(() => []);
  for (const rec of all) {
    try {
      mediaMap[rec.id] = { type: rec.type, name: rec.name || "", dataUrl: await blobToDataURL(rec.blob) };
    } catch {
      /* 单个媒体失败不影响整体导出 */
    }
  }
  const blob = new Blob(
    [JSON.stringify({ app: "ai-life-archive", exportedAt: new Date().toISOString(), moments, letters, media: mediaMap }, null, 2)],
    { type: "application/json" },
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `人生档案馆备份_${localDateStr().replace(/-/g, "")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  const n = Object.keys(mediaMap).length;
  showToast(n ? `备份已导出（含 ${n} 个图片/视频，文件可能较大）` : "备份已导出");
}

function fmtSize(b) {
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + " MB";
  if (b >= 1024) return (b / 1024).toFixed(1) + " KB";
  return b + " B";
}

async function refreshStorageInfo() {
  const fill = $("#storage-fill");
  const text = $("#storage-text");
  const quota = 5 * 1024 * 1024; // localStorage 常规上限按 5MB 估算
  let used = 0;
  try {
    for (const k of Object.values(KEYS)) {
      const v = localStorage.getItem(k);
      if (v) used += (k.length + v.length) * 2; // UTF-16 码元 ≈ 2 字节
    }
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (typeof est.usage === "number" && est.usage > 0) used = est.usage;
    }
  } catch {
    /* 保持估算值 */
  }
  const pct = Math.min(100, Math.max(0, (used / quota) * 100));
  if (fill) fill.style.width = pct.toFixed(1) + "%";
  if (text) {
    const warn = pct > 80 ? " · 快满了，建议尽快导出备份" : pct > 60 ? " · 建议定期导出备份" : "";
    const mc = await idbCountMedia().catch(() => 0);
    text.textContent = `已用 ${fmtSize(used)} / 约 5 MB（${pct.toFixed(1)}%）${mc ? ` · 媒体 ${mc} 个` : ""}${warn}`;
  }
}

function sanitizeMoment(m) {
  const ai = m && m.ai && typeof m.ai === "object" && Array.isArray(m.ai.keywords)
    ? {
        keywords: m.ai.keywords.filter((k) => typeof k === "string").slice(0, 6),
        growth: typeof m.ai.growth === "string" ? m.ai.growth : "",
        advice: typeof m.ai.advice === "string" ? m.ai.advice : "",
        source: m.ai.source === "demo" ? "demo" : "ai",
        provider: ["builtin", "deepseek"].includes(m.ai.provider) ? m.ai.provider : "",
        model: typeof m.ai.model === "string" ? m.ai.model : "",
        at: typeof m.ai.at === "number" ? m.ai.at : Date.now(),
      }
    : null;
  return {
    id: typeof m.id === "string" ? m.id : uid(),
    date: typeof m.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(m.date) ? m.date : localDateStr(),
    mood: moodById(m.mood).id,
    event: typeof m.event === "string" ? m.event : "",
    feeling: typeof m.feeling === "string" ? m.feeling : "",
    gain: typeof m.gain === "string" ? m.gain : "",
    tags: Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === "string").slice(0, 8) : [],
    type: ["success", "normal", "setback"].includes(m.type) ? m.type : "normal",
    media: Array.isArray(m.media)
      ? m.media
          .filter((x) => x && typeof x.id === "string" && (x.type === "image" || x.type === "video"))
          .slice(0, MAX_MEDIA)
          .map((x) => ({
            id: x.id,
            type: x.type,
            name: typeof x.name === "string" ? x.name : "",
            size: typeof x.size === "number" ? x.size : 0,
          }))
      : [],
    createdAt: typeof m.createdAt === "number" ? m.createdAt : Date.now(),
    ai,
  };
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.moments)) throw new Error("bad format");
      if (!confirm("导入将覆盖当前全部档案与信件，确定继续吗？")) return;
      moments = data.moments.map(sanitizeMoment);
      letters = Array.isArray(data.letters) ? data.letters.map((l) => ({
        id: typeof l.id === "string" ? l.id : uid(),
        text: typeof l.text === "string" ? l.text : "",
        unlockDate: typeof l.unlockDate === "string" ? l.unlockDate : localDateStr(),
        createdAt: typeof l.createdAt === "number" ? l.createdAt : Date.now(),
        aiReply: typeof l.aiReply === "string" ? l.aiReply : "",
      })) : [];
      await idbClearMedia().catch(() => {});
      if (data.media && typeof data.media === "object") {
        for (const [id, m] of Object.entries(data.media)) {
          if (m && m.dataUrl) {
            try {
              const blob = await dataURLToBlob(m.dataUrl);
              await idbPutMedia(id, blob, m.type === "video" ? "video" : "image", m.name || "");
            } catch {
              /* 单个媒体失败不影响导入 */
            }
          }
        }
      }
      saveMoments();
      saveLetters();
      ui.year = null;
      ui.tag = null;
      showToast("导入成功（含媒体）");
      renderArchive();
      refreshStorageInfo();
      showScreen("screen-archive", "back");
    } catch {
      showToast("文件格式不正确，请选择导出的备份文件");
    }
  };
  reader.readAsText(file);
}

async function clearAll() {
  if (!confirm("确定清空本机保存的全部档案吗？")) return;
  if (!confirm("最后确认：此操作无法恢复。真的要清空吗？")) return;
  moments = [];
  letters = [];
  await idbClearMedia().catch(() => {});
  saveMoments();
  saveLetters();
  ui.year = null;
  ui.tag = null;
  renderArchive();
  showScreen("screen-archive", "back");
  showToast("档案已清空");
  refreshStorageInfo();
}

/* ---------------- 事件绑定 ---------------- */
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-open-ai-settings]")) {
    openAiSetup({ dismissible: true });
    return;
  }

  const back = e.target.closest("[data-back]");
  if (back) {
    showScreen(back.dataset.back, "back");
    return;
  }

  const yearBtn = e.target.closest("[data-year]");
  if (yearBtn) {
    openYear(yearBtn.dataset.year);
    return;
  }

  const card = e.target.closest("[data-moment-id]");
  if (card) {
    const active = document.querySelector(".screen.active");
    if (active && active.id === "screen-all-timeline") {
      jumpToDetail(card.dataset.momentId);
    } else {
      openDetail(card.dataset.momentId);
    }
    return;
  }

  const chip = e.target.closest("[data-tag]");
  if (chip) {
    ui.tag = chip.dataset.tag || null;
    rerenderYear();
    return;
  }

  const pickOpt = e.target.closest("[data-pick-tag]");
  if (pickOpt) {
    toggleTag(pickOpt.dataset.pickTag);
    return;
  }

  const rmChip = e.target.closest("[data-remove-tag]");
  if (rmChip) {
    removeTag(rmChip.dataset.removeTag);
    return;
  }

  const addOther = e.target.closest("#tag-other-add");
  if (addOther) {
    addOtherTags();
    return;
  }

  const trigger = e.target.closest("#tag-trigger");
  if (trigger) {
    toggleTagPanel();
    return;
  }

  const addSearchTag = e.target.closest("#btn-add-search-tag");
  if (addSearchTag) {
    const r = addTagsFromText((ui.tagSearch || "").trim());
    if (!r.blocked) {
      ui.tagSearch = "";
      $("#tag-search").value = "";
      renderTagOptions();
    }
    return;
  }

  const gotoOther = e.target.closest("#btn-goto-other");
  if (gotoOther) {
    const input = $("#tag-other-input");
    if (input) {
      input.scrollIntoView({ behavior: "smooth", block: "center" });
      input.focus();
    }
    return;
  }

  if (!e.target.closest("#tag-picker")) closeTagPanel();

  const letterAi = e.target.closest("[data-letter-ai]");
  if (letterAi) {
    letterAIReply(letterAi.dataset.letterAi);
    return;
  }

  const goRecord = e.target.closest("#btn-go-record");
  if (goRecord) {
    openEdit(null, "screen-link");
    return;
  }

  const mediaRm = e.target.closest("[data-media-id]");
  if (mediaRm) {
    removePendingMedia(mediaRm.dataset.mediaId);
    return;
  }

  if (e.target.closest("#btn-fail-ai-retry")) {
    runFailureAI();
    return;
  }

  if (e.target.closest("#btn-analyze-retry")) {
    const m = moments.find((x) => x.id === ui.detailId);
    if (m) analyzeMoment(m);
    return;
  }

  if (e.target.closest("#btn-review-retry")) {
    runReview();
    return;
  }

  if (e.target.closest("#btn-link-retry")) {
    runLink();
    return;
  }

  if (e.target.closest("#btn-analyze")) {
    const m = moments.find((x) => x.id === ui.detailId);
    if (m) analyzeMoment(m);
  }
});

function init() {
  document.body.dataset.dir = "forward";

  $("#btn-enter").addEventListener("click", () => {
    if (document.body.dataset.entering) return;
    document.body.dataset.entering = "1";
    const scene = $("#door-scene");
    scene.classList.add("opening");
    renderArchive();
    setTimeout(() => {
      startWarp();
    }, 60); // 门刚有动作就叠上穿梭动画，不等门完全开开
  });

  $("#btn-vault").addEventListener("click", () => {
    renderVault();
    showScreen("screen-vault", "forward");
  });

  $("#btn-data").addEventListener("click", () => {
    refreshStorageInfo();
    renderAiSettingsSummary();
    showScreen("screen-data", "forward");
  });
  $("#btn-link-archive").addEventListener("click", () => openLinkScreen());
  $("#btn-all-timeline").addEventListener("click", () => openAllTimeline("forward", null));
  $("#btn-year-timeline").addEventListener("click", () => openAllTimeline("forward", ui.year));

  $("#btn-new-moment").addEventListener("click", () => openEdit(null, "screen-archive"));
  $("#btn-new-moment-year").addEventListener("click", () => openEdit(null, "screen-year"));
  $("#btn-new-moment-all").addEventListener("click", () => openEdit(null, "screen-all-timeline"));
  bindSafe($("#btn-add-media"), "click", () => { const input = $("#f-media"); if (input) input.click(); });
  bindSafe($("#f-media"), "change", (e) => {
    const files = Array.from(e.target.files || []); // 先快照文件，再清空，避免 FileList 被清空
    e.target.value = "";
    if (files.length) showMediaWarn(files);
  });
  bindSafe($("#media-warn-ok"), "click", confirmMediaWarn);
  bindSafe($("#media-warn-cancel"), "click", cancelMediaWarn);
  bindSafe($("#media-warn-overlay"), "click", (e) => {
    if (e.target.id === "media-warn-overlay") cancelMediaWarn();
  });
  $("#btn-new-letter").addEventListener("click", () => {
    $("#f-letter-date").value = "";
    $("#f-letter-date").min = localDateStr();
    showScreen("screen-letter", "forward");
    $("#f-letter-text").focus();
  });

  $("#moment-form").addEventListener("submit", saveMoment);
  $("#letter-form").addEventListener("submit", saveLetter);

  $("#tag-other-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addOtherTags();
    }
  });

  $("#tag-search").addEventListener("input", (e) => {
    ui.tagSearch = e.target.value;
    renderTagOptions();
  });

  $("#tag-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault();
  });

  $("#btn-edit").addEventListener("click", () => openEdit(ui.detailId, "screen-year"));
  $("#btn-delete").addEventListener("click", deleteCurrentMoment);
  $("#btn-link").addEventListener("click", () => openLinkScreen(ui.detailId));

  $("#link-a").addEventListener("change", (e) => { ui.linkA = e.target.value; });
  $("#link-b").addEventListener("change", (e) => { ui.linkB = e.target.value; });
  $("#btn-link-run").addEventListener("click", runLink);

  $("#btn-review").addEventListener("click", () => {
    $("#review-month").value = localDateStr().slice(0, 7);
    $("#review-result").innerHTML = "";
    showScreen("screen-review", "forward");
  });
  $("#btn-failure").addEventListener("click", () => {
    $("#fail-period-month").value = localDateStr().slice(0, 7);
    $("#fail-period-year").value = localDateStr().slice(0, 4);
    updateFailPeriodInputs();
    $("#fail-stats").innerHTML = "";
    $("#fail-result").innerHTML = "";
    showScreen("screen-failure", "forward");
  });
  $("#btn-review-run").addEventListener("click", runReview);
  $("#fail-scope").addEventListener("change", updateFailPeriodInputs);
  $("#btn-fail-stats").addEventListener("click", runFailureStats);
  $("#btn-fail-ai").addEventListener("click", runFailureAI);

  $("#search-input").addEventListener("input", (e) => {
    ui.search = e.target.value.trim();
    rerenderYear();
  });

  $("#btn-export").addEventListener("click", exportData);
  $("#btn-import").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) importData(f);
    e.target.value = "";
  });
  $("#btn-clear").addEventListener("click", clearAll);

  $("#btn-ai-settings").addEventListener("click", () => openAiSetup({ dismissible: true }));
  $("#btn-clear-deepseek-key").addEventListener("click", clearDeepSeekKey);
  $("#btn-deepseek-confirm").addEventListener("click", confirmDeepSeekKey);
  $("#btn-use-builtin").addEventListener("click", useBuiltinAI);
  $("#ai-setup-close").addEventListener("click", closeAiSetup);
  $("#ai-setup-overlay").addEventListener("click", (e) => {
    if (e.target.id === "ai-setup-overlay") closeAiSetup();
  });
  $("#f-deepseek-key").addEventListener("focus", () => setAiChoice("deepseek"));
  $("#f-deepseek-key").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmDeepSeekKey();
    }
  });

  $("#modal-ok").addEventListener("click", closeModal);
  $("#modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#ai-setup-overlay")?.hidden) {
      closeAiSetup();
      return;
    }
    if (e.key === "Escape") closeModal();
    if (e.key === "Escape") cancelMediaWarn();
  });

  $("#f-ai-now").addEventListener("change", syncAiToggle);
  // 让 iOS 的 :active 按压态生效
  document.addEventListener("touchstart", function () {}, { passive: true });
  renderAiSettingsSummary();
  openAiSetup({ dismissible: false });
}

function renderLinkPickers() {
  const sorted = moments
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.createdAt || 0) - (a.createdAt || 0));

  const countHint = $("#link-count-hint");
  if (countHint) {
    countHint.textContent = moments.length < 2
      ? "当前档案不足 2 条，先记录两段人生片段再连线。"
      : `当前共 ${moments.length} 段档案，已自动选好最近的两段。`;
  }

  if (!moments.length) {
    $("#link-a").innerHTML = `<option value="">暂无档案</option>`;
    $("#link-b").innerHTML = `<option value="">暂无档案</option>`;
    return;
  }

  const opts = sorted
    .map((m) => `<option value="${esc(m.id)}">${esc(fmtCN(m.date))} · ${esc(truncate(m.event, 18))}</option>`)
    .join("");
  $("#link-a").innerHTML = opts;
  $("#link-b").innerHTML = opts;

  if (!ui.linkA || !sorted.some((m) => m.id === ui.linkA)) ui.linkA = sorted[0].id;
  if (!ui.linkB || ui.linkB === ui.linkA || !sorted.some((m) => m.id === ui.linkB)) {
    ui.linkB = (sorted[1] || sorted[0]).id;
  }
  $("#link-a").value = ui.linkA;
  $("#link-b").value = ui.linkB;
}

function openLinkScreen(fromId = null) {
  if (fromId) ui.linkA = fromId;
  renderLinkPickers();
  const backBtn = $("#screen-link [data-back]");
  if (backBtn) backBtn.dataset.back = fromId ? "screen-detail" : "screen-archive";
  const resultEl = $("#link-result");
  if (resultEl) {
    resultEl.innerHTML = moments.length < 2
      ? `<div class="empty">时空连线需要至少 2 段档案。<br><button class="btn-primary" id="btn-go-record" type="button">去记录一段</button></div>`
      : "";
  }
  showScreen("screen-link", "forward");
}

init();
