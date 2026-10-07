export const schemaVersion = 1;
export const migrationSql = `
CREATE TABLE workspaces (
 id TEXT PRIMARY KEY NOT NULL, bot_id TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL,
 budget INTEGER NOT NULL CHECK(budget BETWEEN 0 AND 9007199254740991),
 held INTEGER NOT NULL DEFAULT 0 CHECK(held>=0), spent INTEGER NOT NULL DEFAULT 0 CHECK(spent>=0), authority_revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE scopes (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), id TEXT NOT NULL, bot_id TEXT NOT NULL, chat_id TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)), held INTEGER NOT NULL DEFAULT 0 CHECK(held>=0), spent INTEGER NOT NULL DEFAULT 0 CHECK(spent>=0),
 PRIMARY KEY(workspace_id,id), UNIQUE(bot_id,chat_id), UNIQUE(id)
);
CREATE TABLE bindings (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, bot_id TEXT NOT NULL, chat_id TEXT NOT NULL,
 PRIMARY KEY(bot_id,chat_id), FOREIGN KEY(workspace_id,scope_id) REFERENCES scopes(workspace_id,id)
);
CREATE TABLE memberships (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','manager','member')),
 PRIMARY KEY(workspace_id,scope_id,user_id), FOREIGN KEY(workspace_id,scope_id) REFERENCES scopes(workspace_id,id)
);
CREATE TABLE tasks (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
 held INTEGER NOT NULL DEFAULT 0 CHECK(held>=0), spent INTEGER NOT NULL DEFAULT 0 CHECK(spent>=0), note_sequence INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,scope_id,id), FOREIGN KEY(workspace_id,scope_id) REFERENCES scopes(workspace_id,id)
);
CREATE TABLE sources (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, task_id TEXT, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)), PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,scope_id,id),
 FOREIGN KEY(workspace_id,scope_id) REFERENCES scopes(workspace_id,id), FOREIGN KEY(workspace_id,scope_id,task_id) REFERENCES tasks(workspace_id,scope_id,id)
);
CREATE TABLE messages (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, task_id TEXT, source_id TEXT,
 PRIMARY KEY(workspace_id,scope_id,chat_id,message_id), FOREIGN KEY(workspace_id,scope_id) REFERENCES scopes(workspace_id,id),
 FOREIGN KEY(workspace_id,scope_id,task_id) REFERENCES tasks(workspace_id,scope_id,id), FOREIGN KEY(workspace_id,scope_id,source_id) REFERENCES sources(workspace_id,scope_id,id)
);
CREATE TABLE transcripts (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, task_id TEXT NOT NULL, sequence INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
 PRIMARY KEY(workspace_id,task_id,sequence), FOREIGN KEY(workspace_id,scope_id,task_id) REFERENCES tasks(workspace_id,scope_id,id)
);
CREATE TABLE notes (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, task_id TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,task_id,sequence), FOREIGN KEY(workspace_id,scope_id,task_id) REFERENCES tasks(workspace_id,scope_id,id)
);
CREATE TABLE grants (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,scope_id) REFERENCES scopes(workspace_id,id)
);
CREATE TABLE effects (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, task_id TEXT NOT NULL, id TEXT NOT NULL, call_id TEXT NOT NULL, sequence INTEGER NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)), redacted INTEGER NOT NULL DEFAULT 0 CHECK(redacted IN (0,1)),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,task_id,call_id), UNIQUE(workspace_id,scope_id,task_id,id),
 FOREIGN KEY(workspace_id,scope_id,task_id) REFERENCES tasks(workspace_id,scope_id,id)
);
CREATE TABLE approvals (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, task_id TEXT NOT NULL, effect_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,effect_id), FOREIGN KEY(workspace_id,scope_id,task_id,effect_id) REFERENCES effects(workspace_id,scope_id,task_id,id)
);
CREATE TABLE events (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, task_id TEXT, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,scope_id) REFERENCES scopes(workspace_id,id), FOREIGN KEY(workspace_id,scope_id,task_id) REFERENCES tasks(workspace_id,scope_id,id)
);
CREATE TABLE memories (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,scope_id) REFERENCES scopes(workspace_id,id)
);
CREATE TABLE routines (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,scope_id,id), FOREIGN KEY(workspace_id,scope_id) REFERENCES scopes(workspace_id,id)
);
CREATE TABLE occurrences (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, routine_id TEXT NOT NULL, at INTEGER NOT NULL, task_id TEXT NOT NULL,
 PRIMARY KEY(workspace_id,routine_id,at), FOREIGN KEY(workspace_id,scope_id,routine_id) REFERENCES routines(workspace_id,scope_id,id),
 FOREIGN KEY(workspace_id,scope_id,task_id) REFERENCES tasks(workspace_id,scope_id,id)
);
CREATE TABLE commands (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, user_id TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, receipt TEXT NOT NULL CHECK(json_valid(receipt)),
 PRIMARY KEY(workspace_id,scope_id,user_id,key), FOREIGN KEY(workspace_id,scope_id) REFERENCES scopes(workspace_id,id)
);
CREATE TABLE updates (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, bot_id TEXT NOT NULL, update_id INTEGER NOT NULL, receipt TEXT NOT NULL CHECK(json_valid(receipt)),
 PRIMARY KEY(workspace_id,bot_id,update_id), FOREIGN KEY(workspace_id,scope_id) REFERENCES scopes(workspace_id,id)
);
CREATE TABLE jobs (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, task_id TEXT, id TEXT NOT NULL, entity_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('model','effect','delivery')), data TEXT NOT NULL CHECK(json_valid(data)),
 state TEXT NOT NULL CHECK(state IN ('ready','leased','done','held')), ready_at INTEGER NOT NULL, token TEXT, worker_id TEXT, expires_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,kind,entity_id), UNIQUE(workspace_id,scope_id,task_id,id),
 FOREIGN KEY(workspace_id,scope_id) REFERENCES scopes(workspace_id,id), FOREIGN KEY(workspace_id,scope_id,task_id) REFERENCES tasks(workspace_id,scope_id,id)
);
CREATE INDEX queue_ready ON jobs(state,ready_at,expires_at);
CREATE TABLE reservations (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, task_id TEXT NOT NULL, token TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount>=0), settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1)), charged INTEGER NOT NULL DEFAULT 0 CHECK(charged>=0),
 expired INTEGER NOT NULL DEFAULT 0 CHECK(expired IN (0,1)), epoch INTEGER NOT NULL, authority_revision INTEGER NOT NULL,
 sources TEXT NOT NULL CHECK(json_valid(sources)), memories TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(memories)),
 PRIMARY KEY(workspace_id,token), FOREIGN KEY(workspace_id,scope_id,task_id) REFERENCES tasks(workspace_id,scope_id,id)
);
CREATE TABLE dispatches (
 workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, task_id TEXT NOT NULL, effect_id TEXT NOT NULL, token TEXT NOT NULL,
 PRIMARY KEY(workspace_id,token), FOREIGN KEY(workspace_id,scope_id,task_id,effect_id) REFERENCES effects(workspace_id,scope_id,task_id,id)
);
`;
