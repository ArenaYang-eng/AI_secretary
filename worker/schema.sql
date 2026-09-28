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
