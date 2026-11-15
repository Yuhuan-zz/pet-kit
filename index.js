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
export const LABELS = { feed: '投喂', status: '状态', look: '看眼屏幕' };

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

      // HTTP 入口：给 CLI / 别的插件用，菜单之外的第二条路。
      const ROUTE = '/pet-kit';
      const send = (res, code, obj) => {
        if (res.writableEnded) return;
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      const onlyLoopback = (req) =>
        ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String((req.socket && req.socket.remoteAddress) || ''));
      const handler = async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const rest = decodeURIComponent(url.pathname.slice(ROUTE.length + 1)).replace(/\/+$/, '');
          const pet = url.searchParams.get('pet') || 'main';
          if (!onlyLoopback(req)) return send(res, 403, { ok: false, reason: 'loopback-only' });
          if (rest === 'health' && req.method === 'GET') {
            return send(res, 200, { ok: true, healthy, detail: healthDetail, upstream: baseUrl });
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
        try {
          disposeRoute?.();
        } catch (e) {}
      });
    });
  },
};
