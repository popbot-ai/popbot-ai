import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

let _db: Database.Database | null = null;

const SCHEMA = [
  // v1 — initial schema
  `
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ticket TEXT,
    pr INTEGER,
    branch TEXT,
    type TEXT NOT NULL DEFAULT 'lite',
    mode TEXT NOT NULL DEFAULT 'interactive',
    agent TEXT NOT NULL DEFAULT 'claude',
    status TEXT NOT NULL DEFAULT 'idle',
    snippet TEXT NOT NULL DEFAULT '',
    tokens_used INTEGER NOT NULL DEFAULT 0,
    tokens_budget INTEGER NOT NULL DEFAULT 1000000,
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    closed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_chats_open ON chats(closed_at, last_active_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
  `,
  // v2 — soft delete: chats.deleted_at (nullable). Hidden from all lists
  //      and search; messages preserved so the chat can be restored.
  `
  ALTER TABLE chats ADD COLUMN deleted_at INTEGER;
  CREATE INDEX IF NOT EXISTS idx_chats_deleted ON chats(deleted_at);
  `,
  // v3 — settings: key/value store for app preferences (Linear API key,
  //      GitHub token, UI prefs, …). Values are JSON-encoded strings so
  //      we don't need columns per setting.
  `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v4 — workspace slot allocation. Each chat optionally holds an
  //      integer slot from a fixed pool sized in Preferences. Free slots
  //      are computed by querying open chats with slot_id NOT NULL.
  `
  ALTER TABLE chats ADD COLUMN slot_id INTEGER;
  CREATE INDEX IF NOT EXISTS idx_chats_slot ON chats(slot_id);
  `,
  // v5 — git worktree path. Records the absolute path of the worktree
  //      we created for this chat so we can clean it up on close even
  //      if the user later moves their worktrees directory.
  `
  ALTER TABLE chats ADD COLUMN worktree_path TEXT;
  `,
  // v6 — Claude SDK session UUID. Captured from the SDK's first
  //      message; passed back as `resume` so the model retains
  //      conversation history across chat reopens.
  `
  ALTER TABLE chats ADD COLUMN session_id TEXT;
  `,
  // v7 — generic notifications. Anything in the app can call
  //      `notify(...)` and it gets a row here + a toast + a bell-icon
  //      update. `kind` is the category (drives icon/grouping); `goto`
  //      is the JSON-encoded click action (external URL, internal
  //      kind+targetId for navigate+pulse, or none). `dedup_key` is
  //      what we de-dup against in a rolling time window.
  `
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    goto TEXT NOT NULL DEFAULT '{"type":"none"}',
    dedup_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_unread
    ON notifications(read_at, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_dedup
    ON notifications(dedup_key, created_at DESC);
  `,
  // v8 — richer notification schema (urgency tiers, actor, multiple
  //      actions, source label, subtitle/summary). priority/detail/goto
  //      from v7 stay in place for backward-compat reads of old rows;
  //      writes use the new columns.
  `
  ALTER TABLE notifications ADD COLUMN urgency TEXT NOT NULL DEFAULT 'med';
  ALTER TABLE notifications ADD COLUMN source TEXT NOT NULL DEFAULT '';
  ALTER TABLE notifications ADD COLUMN subtitle TEXT NOT NULL DEFAULT '';
  ALTER TABLE notifications ADD COLUMN summary TEXT NOT NULL DEFAULT '';
  ALTER TABLE notifications ADD COLUMN actor TEXT;
  ALTER TABLE notifications ADD COLUMN actions TEXT NOT NULL DEFAULT '[]';
  `,
  // v9 — Claude SDK SessionStore backing table. The SDK calls
  //      append(key, entries) during a turn and load(key) on resume;
  //      we treat each entry as an opaque JSON blob (the SDK owns
  //      the schema). Idempotency is keyed on entry.uuid where the
  //      SDK supplies one (most entries do). Order within a session
  //      is preserved via the monotonic `seq` column, assigned in
  //      append() under transaction. With this table populated, the
  //      ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl files
  //      are no longer load-bearing for context resume.
  //
  //      Columns:
  //        project_key — caller-defined SDK scope (default = sanitized
  //                      cwd; the SDK key for partitioning sessions).
  //        session_id  — SDK session UUID.
  //        subpath     — '' for the main transcript; non-empty for
  //                      subagent transcripts ('subagents/agent-…').
  //        seq         — monotonic insertion order within a session.
  //        uuid        — entry's stable id when the SDK supplies one;
  //                      NULL for entries without (titles, tags, mode
  //                      markers per the SDK spec).
  //        payload     — JSON blob, exactly what the SDK handed us.
  //        created_at  — wall clock at insertion (debugging only).
  `
  CREATE TABLE IF NOT EXISTS sdk_session_entries (
    project_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    subpath TEXT NOT NULL DEFAULT '',
    seq INTEGER NOT NULL,
    uuid TEXT,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  -- Ordered load: SELECT … ORDER BY seq.
  CREATE INDEX IF NOT EXISTS idx_sdk_session_entries_load
    ON sdk_session_entries(project_key, session_id, subpath, seq);
  -- Idempotent upsert keyed on entry uuid (where present). The
  -- partial-index WHERE clause lets multiple NULL-uuid rows coexist
  -- (which is what the SDK spec wants for non-deduplicable entries).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sdk_session_entries_uuid
    ON sdk_session_entries(project_key, session_id, subpath, uuid)
    WHERE uuid IS NOT NULL;
  `,
  // v10 — per-chat permission rules. JSON-encoded array of
  //       PermissionRule objects (`{tool, action}`). Auto-resolves
  //       matching `canUseTool` prompts in this chat without user
  //       interaction. Global rules live separately in `settings`
  //       under key `permissions.rules`.
  `
  ALTER TABLE chats ADD COLUMN permission_rules TEXT NOT NULL DEFAULT '[]';
  `,
  // v11 — one-time rewrite of `chats.worktree_path` to the new
  //       multi-repo folder layout. Old: `<home>/popbot/worktrees/slot-N`.
  //       New: `<home>/popbot/workspaces/autorpg/slot-N`. The slot
  //       segment is preserved verbatim — only the parent path
  //       changes. Idempotent: rows already on the new shape are left
  //       alone; null/empty rows untouched.
  //
  //       Going forward, chat creation writes the new shape directly
  //       (the path defaults in readGitSettings already use the new
  //       layout). This migration exists to bring an existing install
  //       across the move once.
  `
  UPDATE chats
     SET worktree_path =
           REPLACE(
             worktree_path,
             '/popbot/worktrees/',
             '/popbot/workspaces/autorpg/'
           )
   WHERE worktree_path LIKE '%/popbot/worktrees/%';
  `,
  // v12 — companion migration to v11: rewrite the SDK session-store
  //       project_key column to match the new on-disk layout. The
  //       SDK's project_key is the cwd with `/` replaced by `-`, so
  //       moving worktrees from `<home>/popbot/worktrees/slot-N` to
  //       `<home>/popbot/workspaces/autorpg/slot-N` changes the
  //       project_key from `…-popbot-worktrees-slot-N` to
  //       `…-popbot-workspaces-autorpg-slot-N`. Without this rewrite,
  //       sessionStore.load() returns null after a folder move and
  //       chats resume into fresh, empty sessions.
  //
  //       Idempotent: rows already on the new key shape are left
  //       alone; new installs find nothing matching.
  `
  UPDATE sdk_session_entries
     SET project_key =
           REPLACE(
             project_key,
             '-popbot-worktrees-',
             '-popbot-workspaces-autorpg-'
           )
   WHERE project_key LIKE '%-popbot-worktrees-%';
  `,
  // v13 — multi-repo foundation. Introduces a `repos` table that
  //       owns the per-repo configuration previously stored loose in
  //       settings.git + settings.slots:
  //         - repo_path       absolute path to the source clone
  //         - color           slot-pill background, distinguishes
  //                           multi-repo installs at a glance
  //         - slot_prefix     folder + parking-branch prefix
  //                           (`slot-1`, or e.g. `autorpg-1`)
  //         - default_base    new-chat base branch
  //         - slot_count      how many slots this repo can run in
  //                           parallel (previously `settings.slots.maxCount`,
  //                           but globalizing that doesn't make sense
  //                           once a user has multiple repos)
  //
  //       Chats gain a `repo_id` reference (string match — SQLite
  //       doesn't enforce the FK without a separate constraint,
  //       which keeps existing rows valid even before code starts
  //       writing the field).
  //
  //       Existing chats are backfilled to repo_id='autorpg' so they
  //       resolve against the seeded default. New chats will write a
  //       real repo_id at create time once that wiring lands.
  `
  CREATE TABLE IF NOT EXISTS repos (
    id            TEXT PRIMARY KEY,
    repo_path     TEXT NOT NULL,
    color         TEXT NOT NULL DEFAULT '#6b7cff',
    slot_prefix   TEXT NOT NULL DEFAULT 'slot',
    default_base  TEXT NOT NULL DEFAULT 'develop',
    slot_count    INTEGER NOT NULL DEFAULT 4,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  ALTER TABLE chats ADD COLUMN repo_id TEXT NOT NULL DEFAULT 'app';
  CREATE INDEX IF NOT EXISTS idx_chats_repo ON chats(repo_id, closed_at, deleted_at);
  `,
  // v14 — chat-keyed session storage. The bug: SDK session entries
  //       were keyed by `project_key` (a sanitized cwd), which makes
  //       a chat's history depend on the slot it happens to be
  //       running in. Slot reuse, reassignment, or path migration
  //       all stranded sessions because `project_key` changed but
  //       `chat.id` didn't.
  //
  //       Fix: add a `chat_id` column and switch our store to key on
  //       it. `project_key` stays around for back-compat (and for
  //       legacy entries that didn't have a chat row to attribute
  //       to) but our `load()` and `discoverSessionId` queries
  //       prefer `chat_id` when set.
  //
  //       Backfill: associate existing rows with chats via the
  //       `chats.session_id` index — rows whose `session_id` matches
  //       a current pinned chat.session_id get tagged. Rows whose
  //       session_id is orphaned (no chat references them anymore)
  //       are left with NULL chat_id; they're effectively dead weight
  //       a future cleanup can sweep, but the migration doesn't
  //       destroy them in case the user wants to mine them later.
  //
  //       Going forward, every append also writes chat_id derived
  //       from chats.session_id at write time (see sqliteSessionStore).
  `
  ALTER TABLE sdk_session_entries ADD COLUMN chat_id TEXT;
  UPDATE sdk_session_entries
     SET chat_id = (
       SELECT chats.id FROM chats
        WHERE chats.session_id = sdk_session_entries.session_id
        LIMIT 1
     )
   WHERE chat_id IS NULL;
  CREATE INDEX IF NOT EXISTS idx_sdk_session_entries_chat
    ON sdk_session_entries(chat_id, session_id, subpath, seq);
  `,
  // v15 — per-repo worktree mode. A repo is either 'slots' (current
  //       behavior — pre-allocated pool of N parking-branch worktrees,
  //       chats borrow a slot) or 'ephemeral' (no pool, no parking
  //       branches; each open chat gets its own short-lived worktree
  //       named after its ticket/PR/id, removed on close).
  //
  //       Existing rows default to 'slots' so nothing changes for
  //       installs that haven't opted into ephemeral mode.
  `
  ALTER TABLE repos ADD COLUMN mode TEXT NOT NULL DEFAULT 'slots';
  `,
  // v16 — Codex backend state. Claude and Codex have different native
  //       resume handles, so keep Codex's thread id separate from the
  //       Claude SDK session_id. The raw event cache is intentionally
  //       PopBot-owned: Codex still resumes from ~/.codex/sessions,
  //       but we keep a durable copy of the streamed events for
  //       transcript safety, diagnostics, and restart-with-context
  //       recovery if Codex's own session store goes missing.
  `
  ALTER TABLE chats ADD COLUMN codex_thread_id TEXT;
  ALTER TABLE chats ADD COLUMN codex_model TEXT NOT NULL DEFAULT 'gpt-5.5';
  ALTER TABLE chats ADD COLUMN codex_reasoning_effort TEXT NOT NULL DEFAULT 'medium';

  CREATE TABLE IF NOT EXISTS codex_thread_events (
    chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    thread_id  TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, thread_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_codex_thread_events_thread
    ON codex_thread_events(thread_id, seq);
  `,
  // v17 — Claude model + effort state. Codex already persisted its
  //       selected model and reasoning effort; Claude now does the
  //       same so the two providers can keep independent settings
  //       when a chat switches back and forth.
  `
  ALTER TABLE chats ADD COLUMN claude_model TEXT NOT NULL DEFAULT 'claude-opus-4-8';
  ALTER TABLE chats ADD COLUMN claude_reasoning_effort TEXT NOT NULL DEFAULT 'high';
  `,
];

export function initDb(): Database.Database {
  if (_db) return _db;

  const userDataDir = app.getPath('userData');
  mkdirSync(userDataDir, { recursive: true });
  const dbPath = join(userDataDir, 'popbot.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const currentVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  for (let v = currentVersion; v < SCHEMA.length; v++) {
    db.exec(SCHEMA[v]);
    db.pragma(`user_version = ${v + 1}`);
  }

  _db = db;
  return db;
}

export function db(): Database.Database {
  if (!_db) throw new Error('DB not initialized — call initDb() at app startup');
  return _db;
}

/** True only between initDb() and closeDb(). Background event handlers
 *  (e.g. SDK messages arriving after disposeAll on quit) check this so
 *  they can skip work instead of throwing into the void. */
export function isDbOpen(): boolean {
  return _db !== null;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
