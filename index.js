/**
 * pet-kit-local —— 本机版「投喂 / 状态」
 *
 * 为什么是独立插件：0.4.8 已经原生做了语音/时间/待办/对话，但**没有**饱腹度。
 * 0.3.8 时代它是补丁打进 dsh-pet 包里的，现在那个补丁退役了，这里用 0.4.8 的
 * 公开接口把这两项挂回来：
 *
 *   菜单：POST /dsh-pet-7340/menu/item   { owner, labels }   → 落在右键「更多」下
 *   点击：GET  /dsh-pet-7340/menu/events?owner=&wait=        → 读取即消费
 *   演出：POST /lock → /anim → /broadcast → /lock/release
 *
 * 不碰 dsh-pet 的任何文件，不改它的包，只走 HTTP。
 * 数据落在 <DSH_HOME>/pet-kit/feed-state.json；第一次启动时从
 * <DSH_HOME>/dsh-pet/feed-state.json 续上（饱腹度不从 100% 重来）。
 *
 * @module pet-kit-local
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const OWNER = 'pet-kit';
export const LABELS = { feed: '投喂', status: '状态' };

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
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
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
  };
}

/**
 * 造一个 pet-kit 实例（不含菜单轮询，方便单测）。
 * @param {{ baseUrl: string, statePath: string, log?: (s: string) => void }} opts
 */
export function createPetKit({ baseUrl, statePath, log = () => {} }) {
  const api = makeApi(baseUrl);

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

  return { feed, status, registerMenu: api.registerMenu, readEvents: api.readEvents, api };
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
      const kit = createPetKit({ baseUrl, statePath, log: (s) => console.log('[pet-kit] ' + s) });

      let stopped = false;
      let busy = false;

      // 注册菜单项：dsh-pet 可能比我们晚就绪，失败就退避重试。
      const register = async (attempt = 0) => {
        if (stopped) return;
        try {
          const r = await kit.registerMenu();
          if (r && r.ok === true) {
            console.log('[pet-kit] 菜单已注册：投喂 / 状态（右键「更多」下）');
            return;
          }
        } catch (e) {}
        if (attempt < 30) setTimeout(() => register(attempt + 1), Math.min(2000 + attempt * 1000, 10000));
      };
      register();

      // 点击轮询：长轮询 3 秒，读取即消费。菜单没注册成功也不妨碍（会一直空转）。
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
            } finally {
              busy = false;
            }
          }
        } catch (e) {
          await new Promise((res) => setTimeout(res, 2000));
        }
        if (!stopped) setTimeout(poll, 50);
      };
      poll();

      ctx.effect(() => () => {
        stopped = true;
      });
    });
  },
};
