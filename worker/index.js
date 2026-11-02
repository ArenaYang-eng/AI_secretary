import { buildPushPayload } from '@block65/webcrypto-web-push';

const MAX_SENDS = 4;          // 到期後最多連推幾次（沒被確認才會重推）
const NAG_MS = 60 * 1000;     // 重推間隔
const MAX_REMINDERS = 50;     // 每支手機最多同步幾筆（D1 單次綁定參數上限 100）
const MAX_ITEMS_UP = 200;   // 每次同步最多上傳幾筆
const MAX_ITEMS_DOWN = 500; // 每次同步最多回傳幾筆
const TOMB_MS = 30 * 86400000; // 刪除標記保留 30 天
const PER_RUN = 40;           // 免費方案每次執行最多 50 個對外請求

// 只允許主流推播服務，避免被拿來打任意網址
const PUSH_HOSTS = [
  'web.push.apple.com', 'fcm.googleapis.com',
  'updates.push.services.mozilla.com', 'notify.windows.com'
];
const okEndpoint = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && PUSH_HOSTS.some(h => x.hostname === h || x.hostname.endsWith('.' + h));
  } catch { return false; }
};

const corsHeaders = (env, req) => {
  const o = req.headers.get('Origin');
  const h = { 'Vary': 'Origin' };
  if (o && o === env.ALLOWED_ORIGIN) {
    h['Access-Control-Allow-Origin'] = o;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  return h;
};
const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

export default {
  async fetch(req, env) {
    const cors = corsHeaders(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return json({ ok: true }, 200, cors);
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    // 桌面程式不是瀏覽器、沒有 Origin：只放行同步端點（仍需有效 token）
    const desktopOk = url.pathname === '/api/items/sync' && !origin;
    if (origin !== env.ALLOWED_ORIGIN && !desktopOk) return json({ error: 'forbidden' }, 403, cors);

    let b;
    try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400, cors); }
    const token = String(b.token || '');
    if (token.length < 24 || token.length > 100) return json({ error: 'bad token' }, 400, cors);

    // --- 同步：手機把「未完成的提醒清單」整份送來，伺服器對齊 ---
    if (url.pathname === '/api/sync') {
      const now = Date.now();
      const stmts = [];

      if (b.subscription) {
        const s = b.subscription;
        if (!okEndpoint(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth)
          return json({ error: 'bad subscription' }, 400, cors);
        stmts.push(env.DB.prepare(
          'INSERT INTO subs(token,sub,updated) VALUES(?,?,?) ON CONFLICT(token) DO UPDATE SET sub=excluded.sub, updated=excluded.updated'
        ).bind(token, JSON.stringify({ endpoint: s.endpoint, expirationTime: null, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }), now));
      }

      const list = (Array.isArray(b.reminders) ? b.reminders : [])
        .filter(r => r && r.id != null && Number.isFinite(+r.due))
        .slice(0, MAX_REMINDERS);

      for (const r of list) {
        const id = String(r.id).slice(0, 40);
        const due = Math.floor(+r.due);
        const text = String(r.text || '提醒').slice(0, 120);
        // due 沒變就保留已推播次數；due 改了就重新計算
        stmts.push(env.DB.prepare(
          `INSERT INTO rems(token,id,due,text,sent,next) VALUES(?,?,?,?,0,?)
           ON CONFLICT(token,id) DO UPDATE SET
             text=excluded.text,
             sent=CASE WHEN rems.due<>excluded.due THEN 0 ELSE rems.sent END,
             next=CASE WHEN rems.due<>excluded.due THEN excluded.next ELSE rems.next END,
             due=excluded.due`
        ).bind(token, id, due, text, due));
      }

      // 手機上已刪除 / 完成 / 已確認的，伺服器也移除
      const ids = list.map(r => String(r.id).slice(0, 40));
      if (ids.length) {
        stmts.push(env.DB.prepare(
          `DELETE FROM rems WHERE token=? AND id NOT IN (${ids.map(() => '?').join(',')})`
        ).bind(token, ...ids));
      } else {
        stmts.push(env.DB.prepare('DELETE FROM rems WHERE token=?').bind(token));
      }

      await env.DB.batch(stmts);
      return json({ ok: true, count: list.length }, 200, cors);
    }

    // --- 備忘錄雙向同步：上傳本機變更，回傳其他裝置的變更 ---
    if (url.pathname === '/api/items/sync') {
      const now = Date.now();
      const since = Math.max(0, Math.floor(+b.since || 0));
      const up = (Array.isArray(b.items) ? b.items : [])
        .filter(x => x && x.id != null && Number.isFinite(+x.upd))
        .slice(0, MAX_ITEMS_UP);

      const stmts = up.map(x => {
        const del = x.deleted ? 1 : 0;
        const isRem = x.kind === 'reminder' && Number.isFinite(+x.due) && +x.due > 0;
        return env.DB.prepare(
          `INSERT INTO items(token,id,kind,text,due,done,ackd,deleted,upd,sv)
           VALUES(?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(token,id) DO UPDATE SET
             kind=excluded.kind, text=excluded.text, due=excluded.due, done=excluded.done,
             ackd=excluded.ackd, deleted=excluded.deleted, upd=excluded.upd, sv=excluded.sv
           WHERE excluded.upd > items.upd`
        ).bind(
          token, String(x.id).slice(0, 40), isRem ? 'reminder' : 'note',
          del ? '' : String(x.text || '').slice(0, 500),
          isRem ? Math.floor(+x.due) : 0,
          x.done ? 1 : 0, x.ackd ? 1 : 0, del, Math.floor(+x.upd), now
        );
      });

      if (stmts.length) {
        // 這次寫入成功（較新）的提醒 → 同步進推播表，讓 App 關閉時手機也會響；已完成/確認/刪除的移除
        stmts.push(env.DB.prepare(
          `DELETE FROM rems WHERE token=? AND id IN
             (SELECT id FROM items WHERE token=? AND sv=? AND (deleted=1 OR done=1 OR ackd=1 OR kind<>'reminder'))`
        ).bind(token, token, now));
        stmts.push(env.DB.prepare(
          `INSERT INTO rems(token,id,due,text,sent,next)
             SELECT token,id,due,substr(text,1,120),0,due FROM items
              WHERE token=? AND sv=? AND kind='reminder' AND deleted=0 AND done=0 AND ackd=0 AND due>?
                AND EXISTS (SELECT 1 FROM subs WHERE subs.token=items.token)
           ON CONFLICT(token,id) DO UPDATE SET
             text=excluded.text,
             sent=CASE WHEN rems.due<>excluded.due THEN 0 ELSE rems.sent END,
             next=CASE WHEN rems.due<>excluded.due THEN excluded.next ELSE rems.next END,
             due=excluded.due`
        ).bind(token, now, now - 86400000));
        await env.DB.batch(stmts);
      }

      const { results } = await env.DB.prepare(
        `SELECT id,kind,text,due,done,ackd,deleted,upd,sv FROM items
          WHERE token=? AND sv>? ORDER BY sv LIMIT ?`
      ).bind(token, since, MAX_ITEMS_DOWN + 1).all();
      const more = results.length > MAX_ITEMS_DOWN;
      const rows = results.slice(0, MAX_ITEMS_DOWN);
      return json({
        ok: true, now, more,
        next: rows.length ? rows[rows.length - 1].sv : since,
        items: rows.map(r => ({
          id: r.id, kind: r.kind, text: r.text, due: r.due,
          done: !!r.done, ackd: !!r.ackd, deleted: !!r.deleted, upd: r.upd
        }))
      }, 200, cors);
    }

    // --- 取消訂閱（使用者關閉背景提醒）---
    if (url.pathname === '/api/unsubscribe') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM rems WHERE token=?').bind(token),
        env.DB.prepare('DELETE FROM subs WHERE token=?').bind(token)
      ]);
      return json({ ok: true }, 200, cors);
    }

    return json({ error: 'not found' }, 404, cors);
  },

  // --- 每分鐘執行：找出到期的提醒並推播 ---
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  }
};

async function run(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT r.token, r.id, r.text, r.sent, s.sub
       FROM rems r JOIN subs s ON s.token = r.token
      WHERE r.next <= ? AND r.sent < ?
      ORDER BY r.next LIMIT ?`
  ).bind(now, MAX_SENDS, PER_RUN).all();

  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  };

  for (const r of results) {
    let status = 0;
    try {
      const payload = await buildPushPayload(
        {
          data: JSON.stringify({ id: r.id, n: r.sent + 1, title: '⏰ 小秘書提醒', body: r.text }),
          options: { ttl: 3600, urgency: 'high' }
        },
        JSON.parse(r.sub),
        vapid
      );
      status = (await fetch(JSON.parse(r.sub).endpoint, payload)).status;
    } catch (e) { status = 0; }

    if (status === 404 || status === 410) {
      // 訂閱已失效：清掉，等使用者下次開 App 重新訂閱
      await env.DB.batch([
        env.DB.prepare('DELETE FROM subs WHERE token=?').bind(r.token),
        env.DB.prepare('DELETE FROM rems WHERE token=?').bind(r.token)
      ]);
    } else if (status >= 200 && status < 300) {
      await env.DB.prepare('UPDATE rems SET sent=sent+1, next=? WHERE token=? AND id=?')
        .bind(now + NAG_MS, r.token, r.id).run();
    } else if (status === 429 || status >= 500 || status === 0) {
      // 暫時性錯誤：下一分鐘再試（不增加 sent）
    } else {
      // 其他 4xx（例如 payload/憑證錯誤）：算一次，避免無限重試
      await env.DB.prepare('UPDATE rems SET sent=sent+1, next=? WHERE token=? AND id=?')
        .bind(now + NAG_MS, r.token, r.id).run();
    }
  }

  // 清理：超過 1 天仍未確認的舊資料
  await env.DB.prepare('DELETE FROM rems WHERE due < ?').bind(now - 86400000).run();
  await env.DB.prepare('DELETE FROM items WHERE deleted=1 AND sv < ?').bind(now - TOMB_MS).run();
}
