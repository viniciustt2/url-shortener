CREATE TABLE counters (
    id TEXT PRIMARY KEY,
    value INTEGER NOT NULL CHECK (value >= 0)
);

INSERT INTO counters (id, value)
VALUES ('short-url-sequence', 0);

CREATE TABLE urls (
    numeric_id INTEGER PRIMARY KEY,
    short_code TEXT NOT NULL UNIQUE,
    original_url TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX urls_expiration_idx ON urls (expires_at);

CREATE TABLE click_events (
    event_id TEXT PRIMARY KEY,
    short_code TEXT NOT NULL,
    clicked_at INTEGER NOT NULL
);

CREATE INDEX click_events_short_code_idx ON click_events (short_code);
CREATE INDEX click_events_clicked_at_idx ON click_events (clicked_at);
