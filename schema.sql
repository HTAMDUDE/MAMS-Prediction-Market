PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    balance       REAL NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    last_bonus    TEXT,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS markets (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    question            TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    category            TEXT NOT NULL DEFAULT 'Other',
    b                   REAL NOT NULL,
    status              TEXT NOT NULL DEFAULT 'open',   -- open | resolved | cancelled
    closes_at           TEXT NOT NULL,
    resolved_outcome_id INTEGER,
    resolved_at         TEXT,
    created_by          INTEGER REFERENCES users(id),
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outcomes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id INTEGER NOT NULL REFERENCES markets(id),
    label     TEXT NOT NULL,
    shares    REAL NOT NULL DEFAULT 0,
    position  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    outcome_id INTEGER NOT NULL REFERENCES outcomes(id),
    shares     REAL NOT NULL DEFAULT 0,
    cost       REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, outcome_id)
);

-- shares > 0 for a buy, < 0 for a sell. amount = coins spent (negative when received).
CREATE TABLE IF NOT EXISTS trades (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    market_id  INTEGER NOT NULL REFERENCES markets(id),
    outcome_id INTEGER NOT NULL REFERENCES outcomes(id),
    shares     REAL NOT NULL,
    amount     REAL NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id  INTEGER NOT NULL REFERENCES markets(id),
    prices     TEXT NOT NULL,   -- JSON list, same order as outcomes.position
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id  INTEGER NOT NULL REFERENCES markets(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outcomes_market ON outcomes(market_id);
CREATE INDEX IF NOT EXISTS idx_trades_market   ON trades(market_id);
CREATE INDEX IF NOT EXISTS idx_trades_user     ON trades(user_id);
CREATE INDEX IF NOT EXISTS idx_history_market  ON price_history(market_id);
CREATE INDEX IF NOT EXISTS idx_comments_market ON comments(market_id);
