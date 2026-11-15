/**
 * pet-kit-local —— 本机版「投喂 / 状态 / 看眼屏幕」
 *
 * 为什么是独立插件：0.4.8 已经原生做了语音/时间/待办/对话，但**没有**饱腹度，
 * 也**没有**"她自己看屏幕"这条主动行为。0.3.8 时代这两块是补丁打进 dsh-pet 包里的，
 * 现在那个补丁退役了，这里用 0.4.8 的公开接口挂回来：
 *
 *   菜单：POST /dsh-pet-7340/menu/item   { owner, labels }   → 落在右键「更多」下
 *   点击：GET  /dsh-pet-7340/menu/events?owner=&wait=        → 读取即消费
 *   说话：POST /lock → /anim → /broadcast → /lock/release
 *   看屏：ffmpeg ddagrab 抓一帧 → POST /chat（带 attachment）→ 进她的记忆
 *
 * 不碰 dsh-pet 的任何文件，不改它的包，只走 HTTP。
 * 数据落在 <DSH_HOME>/pet-kit/：feed-state.json（饱腹度）、config.json（看屏设置）、
 * look-stat.json（每日预算计数）。饱腹度首次从 dsh-pet 目录续上，不从 100% 重来。
 *
 * @module pet-kit-local
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const OWNER = 'pet-kit';
export const LABELS = { feed: '投喂', status: '状态', look: '看眼屏幕', settings: '看屏设置' };

/* ---------------- 饱腹度规则（与 0.3.8 补丁逐字一致） ---------------- */
const FEED_DEFAULT = 100;
const FEED_DECAY_PER_HOUR = 5;
const FEED_DECAY_START_H = 8;
const FEED_HOUR_MS = 3600000;
const FEED_MEALS = [
  { id: 'breakfast', from: 360, to: 570, anim: '吃早餐', add: 20 },
  { id: 'lunch', from: 690, to: 840, anim: '吃午餐', add: 45 },
  { id: 'dinner', from: 990, to: 1140, anim: '吃晚餐', add: 35 },
];
const FEED_SNACK_ANIMS = ['吃冰淇淋融化', '吃西瓜', '吃糖葫芦'];
const FEED_LINES = {
  satisfied: ['还吃？你是想让我胖成鲸鱼吗', '唔…就一口，就一口哦'],
  peckish: ['刚刚好，谢啦', '嗯——这个不错'],
  hungry: ['终于…再晚一会儿我就要啃桌角了', '总算想起来了'],
  starving: ['救、救命恩人！', '呜呜，好吃…你是好人'],
};
const FEED_AGAIN_LINES = ['刚吃过啦，你是把我当饭桶吗', '又来？我肚子还鼓着呢'];
const FEED_SNACK_LIMIT_LINES = ['今天的零食额度用完咯，明天再说', '再吃下去我真的要变成球了'];
const FEED_TIER_CN = { satisfied: '满足', peckish: '还行', hungry: '有点饿', starving: '饿了' };
const MEAL_CN = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const tierOf = (v) => (v >= 80 ? 'satisfied' : v >= 60 ? 'peckish' : v >= 30 ? 'hungry' : 'starving');
const dayKey = (d) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

function decayMs(fromMs, toMs) {
  let total = 0;
  let cur = fromMs;
  while (cur < toMs) {
    const d = new Date(cur);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const segStart = Math.max(cur, dayStart + FEED_DECAY_START_H * FEED_HOUR_MS);
    const segEnd = Math.min(toMs, dayStart + 24 * FEED_HOUR_MS);
    if (segEnd > segStart) total += segEnd - segStart;
    cur = dayStart + 24 * FEED_HOUR_MS;
  }
  return total;
}

/** 读状态 → 算到此刻 → 返回结果（不落盘）。statePath 不存在时给默认值。 */
export function computeFeed(statePath, nowMs) {
  let st = null;
  try {
    st = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    st = null;
  }
  if (!st || typeof st.satiety !== 'number') st = { satiety: FEED_DEFAULT, updatedAt: nowMs, eaten: null };
  const last = Number(st.updatedAt) || nowMs;
  const dd = nowMs > last ? decayMs(last, nowMs) : 0;
  let satiety = Math.max(0, Math.min(100, st.satiety - (dd / FEED_HOUR_MS) * FEED_DECAY_PER_HOUR));
  const tierBefore = tierOf(satiety);
  const now = new Date(nowMs);
  const key = dayKey(now);
  const eaten =
    st.eaten && st.eaten.day === key
      ? { day: key, meals: { ...st.eaten.meals }, snacks: Number(st.eaten.snacks) || 0 }
      : { day: key, meals: {}, snacks: 0 };
  const minutes = now.getHours() * 60 + now.getMinutes();
  const meal = FEED_MEALS.find((m) => minutes >= m.from && minutes < m.to) || null;
  let anim;
  let line;
  let add = 0;
  let reason = 'ok';
  if (meal) {
    anim = meal.anim;
    if (eaten.meals[meal.id]) {
      line = pick(FEED_AGAIN_LINES);
      reason = 'again';
    } else {
      add = meal.add;
      line = pick(FEED_LINES[tierBefore]);
      eaten.meals[meal.id] = true;
    }
  } else {
    anim = pick(FEED_SNACK_ANIMS);
    if (eaten.snacks >= 2) {
      line = pick(FEED_SNACK_LIMIT_LINES);
      reason = 'snack-limit';
    } else {
      add = 8;
      line = pick(FEED_LINES[tierBefore]);
      eaten.snacks += 1;
    }
  }
  satiety = Math.max(0, Math.min(100, satiety + add));
  return {
    satiety,
    tier: tierOf(satiety),
    tierBefore,
    meal: meal ? meal.id : 'snack',
    anim,
    line,
    add,
    reason,
    eaten,
    updatedAt: nowMs,
  };
}

/** 状态文案：饱腹度 + 今天吃了什么。 */
export function statusText(r) {
  const meals = (r.eaten && r.eaten.meals) || {};
  const parts = Object.keys(meals).filter((k) => meals[k]).map((k) => MEAL_CN[k] ?? k);
  if (r.eaten && r.eaten.snacks > 0) parts.push('零食×' + r.eaten.snacks);
  return (
    '饱腹度 ' + Math.round(r.satiety) + '%（' + (FEED_TIER_CN[r.tier] ?? '未知') + '）· 今天' +
    (parts.length > 0 ? '吃了：' + parts.join('、') : '还没吃')
  );
}

/* ---------------- 与 dsh-pet 的 HTTP 通信 ---------------- */

function makeApi(baseUrl) {
  const call = async (path, { method = 'GET', body, timeoutMs = 8000 } = {}) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, reason: 'bad-json', raw: text.slice(0, 200) };
    }
  };
  return {
    state: () => call('/state'),
    registerMenu: () => call('/menu/item', { method: 'POST', body: { owner: OWNER, labels: Object.values(LABELS), target: 'both' } }),
    readEvents: (wait = 3000) => call(`/menu/events?owner=${encodeURIComponent(OWNER)}&wait=${wait}`),
    lock: (pet, ttl = 20000) => call(`/lock?pet=${encodeURIComponent(pet)}&surface=any`, { method: 'POST', body: { ttl } }),
    release: (pet, lockId) => call(`/lock/release?pet=${encodeURIComponent(pet)}&surface=any`, { method: 'POST', body: { lockId } }),
    anim: (pet, lockId, name) => call(`/anim?pet=${encodeURIComponent(pet)}&surface=any&lock=${encodeURIComponent(lockId)}`, { method: 'POST', body: { name } }),
    broadcast: (pet, lockId, payload) => call(`/broadcast?pet=${encodeURIComponent(pet)}&surface=any&lock=${encodeURIComponent(lockId)}`, { method: 'POST', body: payload }),
    // 看屏走 /chat：图片进她的对话记忆，回复自动进气泡（不用再二次投喂）
    chat: (pet, body) => call(`/chat?pet=${encodeURIComponent(pet)}&surface=any`, { method: 'POST', body, timeoutMs: 60000 }),
  };
}

/* ---------------- 看屏：抓帧 + 触发策略 ---------------- */

const LOOK_DEFAULTS = {
  mode: 'passive', // passive=只有点菜单才看；active=定时看
  intervalSec: 90,
  dailyBudget: 24,
  prompt: '（她抬眼看了下屏幕）',
  ffmpeg: 'ffmpeg',
  width: 1600,
  quality: 4,
};

function readLookConfig(configPath) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    raw = {};
  }
  return { ...LOOK_DEFAULTS, ...(raw.look || {}) };
}

/** 首次运行时落一份默认配置，用户不用猜字段名；已存在就一个字不动。 */
export function ensureConfig(configPath) {
  try {
    if (readFileSync(configPath, 'utf8')) return { created: false };
  } catch (e) {}
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ look: LOOK_DEFAULTS }, null, 2) + '\n', 'utf8');
    return { created: true };
  } catch (e) {
    return { created: false, error: String((e && e.message) || e) };
  }
}

/**
 * 校验并合并 look 配置（设置页与 HTTP 共用同一份规则）。
 * 只接受白名单字段；数值限界；不传的字段原样保留。
 */
const LOOK_LIMITS = { intervalSec: [15, 3600], dailyBudget: [0, 500], width: [320, 3840], quality: [1, 10] };

export function sanitizeLook(patch) {
  if (!patch || typeof patch !== 'object') return { error: 'bad-body' };
  const out = {};
  if (patch.mode !== undefined) {
    if (patch.mode !== 'passive' && patch.mode !== 'active') return { error: 'mode' };
    out.mode = patch.mode;
  }
  for (const [k, [min, max]] of Object.entries(LOOK_LIMITS)) {
    if (patch[k] === undefined) continue;
    const n = Number(patch[k]);
    if (!Number.isFinite(n) || n < min || n > max) return { error: k };
    out[k] = Math.round(n);
  }
  if (patch.prompt !== undefined) {
    const s = String(patch.prompt).trim();
    if (!s || s.length > 100) return { error: 'prompt' };
    out.prompt = s;
  }
  if (patch.ffmpeg !== undefined) {
    const s = String(patch.ffmpeg).trim();
    if (!s || s.length > 260) return { error: 'ffmpeg' };
    out.ffmpeg = s;
  }
  return { ok: out };
}

/** 把校验过的 look 补丁写进配置（保留其它字段），返回合并后的 look。 */
export function writeLookConfig(configPath, patch) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')) || {};
  } catch (e) {
    raw = {};
  }
  const merged = { ...raw, look: { ...(raw.look || {}), ...patch } };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged.look;
}

/** 设置页：一个自包含的 HTML，不依赖任何前端资源。 */
export const SETTINGS_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>pet-kit 设置</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:32px}
 main{max-width:640px;margin:0 auto}
 h1{font-size:18px;margin:0 0 4px} p.sub{color:#8b93a1;margin:0 0 24px}
 fieldset{border:1px solid #262a33;border-radius:10px;padding:16px 18px;margin:0 0 16px}
 legend{color:#9aa4b2;padding:0 6px}
 label{display:block;margin:12px 0 6px;color:#c9d1db}
 input[type=text],input[type=number]{width:100%;box-sizing:border-box;background:#161a21;border:1px solid #2b313b;
  border-radius:8px;color:#e6e6e6;padding:9px 10px;font:inherit}
 .row{display:flex;gap:16px}.row>div{flex:1}
 .hint{color:#77808d;font-size:12px;margin-top:4px}
 .modes{display:flex;gap:10px;margin-top:6px}
 .modes label{display:flex;align-items:center;gap:8px;flex:1;margin:0;padding:10px 12px;border:1px solid #2b313b;
  border-radius:8px;cursor:pointer;background:#161a21}
 .modes input{margin:0}
 button{background:#2f6feb;color:#fff;border:0;border-radius:8px;padding:10px 18px;font:inherit;cursor:pointer}
 button:disabled{opacity:.5;cursor:default}
 output{display:block;margin-top:14px;color:#6fb37a;min-height:20px}
 output.err{color:#e0645f}
</style></head><body><main>
<h1>pet-kit 设置</h1>
<p class="sub">看屏（「看眼屏幕」）的行为。保存后立刻生效，不用重启。</p>
<form id="f">
 <fieldset><legend>什么时候看</legend>
  <div class="modes">
   <label><input type="radio" name="mode" value="passive"> 只在我点的时候看</label>
   <label><input type="radio" name="mode" value="active"> 定时自己看</label>
  </div>
  <p class="hint">定时模式每次看都会出声（她念一句），并算一次模型调用。</p>
  <div class="row">
   <div><label>最小间隔（秒）</label><input type="number" name="intervalSec" min="15" max="3600" step="5"></div>
   <div><label>每天最多（次）</label><input type="number" name="dailyBudget" min="0" max="500" step="1"></div>
  </div>
 </fieldset>
 <fieldset><legend>抓屏</legend>
  <label>ffmpeg 路径</label><input type="text" name="ffmpeg" placeholder="ffmpeg">
  <p class="hint">留空或写 ffmpeg = 从 PATH 找。没有 ffmpeg 就看不了屏。</p>
  <div class="row">
   <div><label>抓帧宽度</label><input type="number" name="width" min="320" max="3840" step="80"></div>
   <div><label>JPEG 质量（1 最好，10 最小）</label><input type="number" name="quality" min="1" max="10" step="1"></div>
  </div>
 </fieldset>
 <fieldset><legend>她对屏幕说的那句话</legend>
  <label>提示词</label><input type="text" name="prompt" maxlength="100">
  <p class="hint">这句会作为你对她说的那一句进对话记忆，她的回复自动进气泡。</p>
 </fieldset>
 <button type="submit" id="save">保存</button>
 <output id="msg"></output>
</form>
</main><script>
const $ = (n) => document.querySelector('[name="' + n + '"]');
const msg = document.getElementById('msg');
const all = ['mode','intervalSec','dailyBudget','ffmpeg','width','quality','prompt'];
async function load(){
  const r = await fetch('/pet-kit/config').then(r=>r.json());
  const c = r.config || {};
  for (const k of all){
    if (k === 'mode'){ document.querySelectorAll('[name=mode]').forEach(el=>el.checked = el.value === c.mode); }
    else if (k in c) $(k).value = c[k];
  }
}
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  body.mode = document.querySelector('[name=mode]:checked')?.value;
  for (const k of ['intervalSec','dailyBudget','width','quality']) body[k] = Number($(k).value);
  body.ffmpeg = $('ffmpeg').value.trim();
  body.prompt = $('prompt').value.trim();
  const btn = document.getElementById('save'); btn.disabled = true;
  msg.className = ''; msg.textContent = '保存中…';
  try {
    const r = await fetch('/pet-kit/config', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.ok) { msg.textContent = '已保存：' + j.config.mode + '，间隔 ' + j.config.intervalSec + ' 秒'; }
    else { msg.className = 'err'; msg.textContent = '没保存成功：' + (j.reason || '未知错误') + (j.field ? '（' + j.field + '）' : ''); }
  } catch (err) { msg.className = 'err'; msg.textContent = '没保存成功：' + err.message; }
  btn.disabled = false;
});
load();
</script></body></html>`;

/** 用系统默认浏览器打开一个本地地址（设置页用）。 */
export function openInBrowser(url) {
  try {
    if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
    else if (process.platform === 'darwin') execFile('open', [url]);
    else execFile('xdg-open', [url]);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 抓一帧屏幕（JPEG 字节，不落盘）。
 * 用 ffmpeg 的 ddagrab（DXGI Desktop Duplication）：和 Electron 的 desktopCapturer 一样是
 * **合成后的桌面**，所以视频/硬件加速的画面不会像 GDI 那样截成白屏。
 * 游戏要开无边窗（独占全屏不进合成，谁抓都是黑的）。
 */
function grabScreen({ ffmpeg, width, quality }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'ddagrab=output_idx=0',
      '-vf', `hwdownload,format=bgra,scale=${width}:-2`,
      '-frames:v', '1', '-f', 'mjpeg', '-q:v', String(quality), 'pipe:1',
    ];
    execFile(ffmpeg, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
      if (err) reject(err);
      else if (!stdout || stdout.length < 1000) reject(new Error('ffmpeg 没有吐出有效帧'));
      else resolve(Buffer.from(stdout));
    });
  });
}

/**
 * 造一个 pet-kit 实例（不含菜单轮询，方便单测）。
 * @param {{ baseUrl: string, statePath: string, log?: (s: string) => void }} opts
 */
export function createPetKit({ baseUrl, statePath, configPath = join(dirname(statePath), 'config.json'), log = () => {} }) {
  const api = makeApi(baseUrl);
  const statPath = join(dirname(configPath), 'look-stat.json');
  let lastFrameHash = '';

  /** 一次完整的「说一句 + 演一次」：锁 → 动画 → 气泡 → 放锁。 */
  async function perform(petId, { text, anim, duration }) {
    const l = await api.lock(petId);
    if (!l || l.ok !== true || !l.lockId) return { ok: false, reason: l?.reason || 'lock-failed' };
    try {
      let animError = null;
      if (anim) {
        const a = await api.anim(petId, l.lockId, anim);
        if (!a || a.ok !== true) animError = a?.reason || 'anim-failed';
      }
      const b = await api.broadcast(petId, l.lockId, { text, duration, anim: false });
      if (!b || b.ok !== true) return { ok: false, reason: b?.reason || 'broadcast-failed', animError };
      return { ok: true, animError };
    } finally {
      try {
        await api.release(petId, l.lockId);
      } catch (e) {}
    }
  }

  async function feed(petId = 'main') {
    const r = computeFeed(statePath, Date.now());
    // 先记账，后说话：饱腹度是数据真相，气泡失败只影响体验。
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ satiety: r.satiety, updatedAt: r.updatedAt, eaten: r.eaten }, null, 2), 'utf8');
    const out = await perform(petId, { text: r.line, anim: r.anim, duration: 6000 });
    log(`feed pet=${petId} satiety=${r.satiety.toFixed(1)} reason=${r.reason} spoken=${out.ok}${out.animError ? ' anim=' + out.animError : ''}`);
    return { ok: out.ok, satiety: Math.round(r.satiety * 10) / 10, tier: r.tier, line: r.line, anim: r.anim, reason: r.reason, spoken: out.ok, animError: out.animError || null };
  }

  async function status(petId = 'main') {
    const r = computeFeed(statePath, Date.now());
    const text = statusText(r);
    const out = await perform(petId, { text, anim: null, duration: 8000 });
    log(`status pet=${petId} satiety=${r.satiety.toFixed(1)}`);
    return { ok: out.ok, satiety: Math.round(r.satiety * 10) / 10, tier: r.tier, text, spoken: out.ok };
  }

  /**
   * 看一眼前屏，让她说一句（走 /chat：进记忆，回复自动进气泡）。
   * force=true 是手动点击：绕过模式、去重和每日预算（用户明确要看）。
   */
  async function look(petId = 'main', { force = false } = {}) {
    const cfg = readLookConfig(configPath);
    if (!force && cfg.mode !== 'active') return { ok: false, reason: 'passive-mode' };

    // 每日预算（手动点击不计）
    const today = new Date().toISOString().slice(0, 10);
    let stat = { day: today, count: 0 };
    try {
      const s = JSON.parse(readFileSync(statPath, 'utf8'));
      if (s && s.day === today) stat = { day: today, count: Number(s.count) || 0 };
    } catch (e) {}
    if (!force && stat.count >= Number(cfg.dailyBudget || 0)) return { ok: false, reason: 'daily-budget' };

    let buf;
    try {
      buf = await grabScreen(cfg);
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 160);
      log(`look 抓帧失败：${msg}`);
      return { ok: false, reason: 'capture-failed', message: msg };
    }

    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    if (!force && hash === lastFrameHash) return { ok: false, reason: 'same-frame' };
    lastFrameHash = hash;

    stat = { day: today, count: stat.count + 1 };
    try {
      mkdirSync(dirname(statPath), { recursive: true });
      writeFileSync(statPath, JSON.stringify(stat), 'utf8');
    } catch (e) {}

    const res = await api.chat(petId, {
      text: cfg.prompt,
      attachment: { mediaType: 'image/jpeg', data: buf.toString('base64') },
    });
    const ok = !!(res && res.ok === true);
    log(`look pet=${petId} bytes=${buf.length} hash=${hash} ok=${ok}${ok ? ' text=' + String(res.text || '').slice(0, 24) : ' reason=' + (res && res.reason)}`);
    return ok
      ? { ok: true, bytes: buf.length, text: res.text, image: res.image }
      : { ok: false, reason: (res && res.reason) || 'chat-failed', message: res && res.message, bytes: buf.length };
  }

  return { feed, status, look, registerMenu: api.registerMenu, readEvents: api.readEvents, api };
}

/** 数据路径：<DSH_HOME>/pet-kit/feed-state.json，首次从 dsh-pet 目录续上。 */
export function resolvePaths(dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  const statePath = join(dshHome, 'pet-kit', 'feed-state.json');
  const legacy = join(dshHome, 'dsh-pet', 'feed-state.json');
  if (!readFileSafe(statePath) && readFileSafe(legacy)) {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, readFileSafe(legacy), 'utf8');
    } catch (e) {}
  }
  return { statePath, legacy };
}

function readFileSafe(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/* ---------------- Cordis 插件外壳 ---------------- */

export default {
  name: OWNER,
  apply(root) {
    root.inject(['webServer'], (ctx) => {
      const port = ctx.webServer?.port;
      if (!port) {
        console.warn('[pet-kit] 拿不到 webServer 端口，投喂/状态不可用');
        return;
      }
      const baseUrl = `http://127.0.0.1:${port}/dsh-pet-7340`;
      const { statePath } = resolvePaths();
      const configPath = join(dirname(statePath), 'config.json');
      ensureConfig(configPath);
      const kit = createPetKit({ baseUrl, statePath, configPath, log: (s) => console.log('[pet-kit] ' + s) });

      let stopped = false;
      let busy = false;
      let healthy = false;
      let healthDetail = '还没检查';
      let pollStarted = false;

      /**
       * 健康检查：不只比版本号，直接打两枪——`/state` 的形状对不对、菜单能不能注册。
       * 版本号在 `/config/meta` 里拿不到（只有 user/default/…/profile），而"接口行为对不对"
       * 本来就是我们唯一真正依赖的东西。
       */
      const checkHealth = async () => {
        try {
          const st = await kit.api.state();
          if (!st || typeof st.counter !== 'number' || typeof st.pets !== 'object') throw new Error('/state 形状不对');
          const m = await kit.registerMenu();
          if (!m || m.ok !== true) throw new Error('menu/item 注册失败：' + ((m && m.reason) || '未知'));
          healthy = true;
          healthDetail = 'ok';
          return true;
        } catch (e) {
          healthy = false;
          healthDetail = String((e && e.message) || e).slice(0, 160);
          return false;
        }
      };

      // 点击轮询：长轮询 3 秒，读取即消费。
      const poll = async () => {
        if (stopped) return;
        try {
          const r = await kit.readEvents(3000);
          // dsh-pet 的内存菜单表会被宿主重启清空（我们这边却还"活着"）—— 丢了就立刻补登记。
          if (r && r.reason === 'unknown-owner') {
            console.warn('[pet-kit] 菜单登记丢了，重新注册');
            await kit.registerMenu();
          }
          const events = (r && r.ok && r.events) || {};
          for (const [label, petIdOrNull] of Object.entries(events)) {
            // 事件表里每个 label 常驻，值是 null = 这次没点它。只有非空字符串才是真的点击。
            if (typeof petIdOrNull !== 'string' || petIdOrNull === '') continue;
            const petId = petIdOrNull;
            if (busy) continue;
            busy = true;
            try {
              if (label === LABELS.feed) await kit.feed(petId);
              else if (label === LABELS.status) await kit.status(petId);
              else if (label === LABELS.look) await kit.look(petId, { force: true });
              else if (label === LABELS.settings) openInBrowser(`http://127.0.0.1:${port}/pet-kit/settings`);
            } finally {
              busy = false;
            }
          }
        } catch (e) {
          await new Promise((res) => setTimeout(res, 2000));
        }
        if (!stopped) setTimeout(poll, 50);
      };

      // 健康检查通过才开始轮询；dsh-pet 可能比我们晚就绪，所以带退避重试。
      const boot = async (attempt = 0) => {
        if (stopped) return;
        if (await checkHealth()) {
          console.log('[pet-kit] 健康检查通过，菜单已注册（投喂 / 状态 / 看眼屏幕）');
          if (!pollStarted) {
            pollStarted = true;
            poll();
          }
          return;
        }
        if (attempt < 30) setTimeout(() => boot(attempt + 1), Math.min(2000 + attempt * 1000, 10000));
        else console.warn('[pet-kit] 健康检查连续失败，已禁用：' + healthDetail);
      };
      boot();

      // 主动看屏：每 15 秒醒一次，读配置决定要不要看。默认 passive ⇒ 这里什么都不做。
      let lastLookAt = 0;
      const tick = setInterval(() => {
        if (stopped || busy || !healthy) return;
        const cfg = readLookConfig(configPath);
        if (cfg.mode !== 'active') return;
        if (Date.now() - lastLookAt < Number(cfg.intervalSec || 90) * 1000) return;
        lastLookAt = Date.now();
        busy = true;
        kit
          .look('main')
          .catch(() => {})
          .finally(() => {
            busy = false;
          });
      }, 15000);
      tick.unref?.();

      // 心跳：每 60 秒重新登记一次菜单。dsh-pet 的菜单表在它自己的宿主重启后会清空，
      // 而我们这边毫无感知（healthy 还停在启动时的结果）—— 这是 2026-11-15 真丢过一次的教训。
      const heartbeat = setInterval(async () => {
        if (stopped) return;
        try {
          const m = await kit.registerMenu();
          if (m && m.ok === true) {
            if (!healthy) console.log('[pet-kit] 菜单恢复登记');
            healthy = true;
            healthDetail = 'ok';
          } else {
            healthy = false;
            healthDetail = 'menu/item 注册失败：' + ((m && m.reason) || '未知');
          }
        } catch (e) {
          healthy = false;
          healthDetail = String((e && e.message) || e).slice(0, 160);
        }
      }, 60000);
      heartbeat.unref?.();

      // HTTP 入口：给 CLI / 别的插件用，菜单之外的第二条路。
      const ROUTE = '/pet-kit';
      const send = (res, code, obj) => {
        if (res.writableEnded) return;
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      const onlyLoopback = (req) =>
        ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String((req.socket && req.socket.remoteAddress) || ''));
      const sendHtml = (res, html) => {
        if (res.writableEnded) return;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
      };
      const readBody = (req) =>
        new Promise((resolve) => {
          let s = '';
          req.on('data', (c) => {
            s += c;
            if (s.length > 64 * 1024) req.destroy();
          });
          req.on('end', () => resolve(s));
        });
      const settingsUrl = `http://127.0.0.1:${port}${ROUTE}/settings`;
      const handler = async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const rest = decodeURIComponent(url.pathname.slice(ROUTE.length + 1)).replace(/\/+$/, '');
          const pet = url.searchParams.get('pet') || 'main';
          if (!onlyLoopback(req)) return send(res, 403, { ok: false, reason: 'loopback-only' });
          if (rest === 'health' && req.method === 'GET') {
            return send(res, 200, { ok: true, healthy, detail: healthDetail, upstream: baseUrl, settings: settingsUrl });
          }
          // 设置页与配置读写：pet 挂了也要能用，所以放在 healthy 判断之前。
          if (rest === 'settings' && req.method === 'GET') return sendHtml(res, SETTINGS_HTML);
          if (rest === 'config' && req.method === 'GET') {
            return send(res, 200, { ok: true, config: readLookConfig(configPath) });
          }
          if (rest === 'config' && req.method === 'POST') {
            const raw = await readBody(req);
            let body;
            try {
              body = JSON.parse(raw || '{}');
            } catch (e) {
              return send(res, 400, { ok: false, reason: 'bad-json' });
            }
            const v = sanitizeLook(body);
            if (v.error) return send(res, 400, { ok: false, reason: 'invalid-field', field: v.error });
            const saved = writeLookConfig(configPath, v.ok);
            return send(res, 200, { ok: true, config: { ...readLookConfig(configPath), ...saved } });
          }
          if (req.method !== 'POST') return send(res, 405, { ok: false, reason: 'method-not-allowed' });
          if (!healthy) return send(res, 503, { ok: false, reason: 'not-ready', detail: healthDetail });
          if (rest === 'feed') return send(res, 200, await kit.feed(pet));
          if (rest === 'status') return send(res, 200, await kit.status(pet));
          if (rest === 'look') return send(res, 200, await kit.look(pet, { force: true }));
          return send(res, 404, { ok: false, reason: 'unknown-route' });
        } catch (e) {
          return send(res, 500, { ok: false, reason: 'error', message: String((e && e.message) || e) });
        }
      };
      const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler });

      ctx.effect(() => () => {
        stopped = true;
        clearInterval(tick);
        clearInterval(heartbeat);
        try {
          disposeRoute?.();
        } catch (e) {}
      });
    });
  },
};
