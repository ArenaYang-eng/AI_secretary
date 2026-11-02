CREATE TABLE IF NOT EXISTS subs (
  token   TEXT PRIMARY KEY,      -- 手機端產生的隨機密鑰（等同密碼）
  sub     TEXT NOT NULL,         -- Push Subscription JSON
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rems (
  token TEXT NOT NULL,
  id    TEXT NOT NULL,
  due   INTEGER NOT NULL,        -- 到期時間 (ms)
  text  TEXT NOT NULL,
  sent  INTEGER NOT NULL DEFAULT 0,  -- 已推播次數
  next  INTEGER NOT NULL,        -- 下次可推播時間 (ms)
  PRIMARY KEY (token, id)
);
CREATE INDEX IF NOT EXISTS idx_rems_next ON rems(next);

-- 備忘錄 / 提醒雙向同步（手機 PWA ⇄ 桌面小工具）
CREATE TABLE IF NOT EXISTS items (
  token   TEXT NOT NULL,
  id      TEXT NOT NULL,
  kind    TEXT NOT NULL,                 -- 'reminder'（有時間）或 'note'（純備忘）
  text    TEXT NOT NULL DEFAULT '',
  due     INTEGER NOT NULL DEFAULT 0,    -- 提醒時間 (ms)，備忘為 0
  done    INTEGER NOT NULL DEFAULT 0,
  ackd    INTEGER NOT NULL DEFAULT 0,    -- 已在任一裝置確認（不再推播）
  deleted INTEGER NOT NULL DEFAULT 0,    -- 刪除標記（保留 30 天讓其他裝置同步）
  upd     INTEGER NOT NULL,              -- 裝置端最後修改時間（衝突時較新者勝）
  sv      INTEGER NOT NULL,              -- 伺服器寫入時間（增量拉取用）
  PRIMARY KEY (token, id)
);
CREATE INDEX IF NOT EXISTS idx_items_sv ON items(token, sv);
