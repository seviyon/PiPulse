import type { DatabaseSync } from 'node:sqlite';

/** Every saved setting by key ("retention.raw"), values parsed from JSON. */
export function getSettings(db: DatabaseSync): Record<string, unknown> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as unknown as {
    key: string;
    value: string;
  }[];
  const settings: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      // A corrupt row reads as unset; the default applies until it is saved again.
    }
  }
  return settings;
}

/** Saves every entry in one transaction; a value of `undefined` deletes its key. */
export function saveSettings(
  db: DatabaseSync,
  values: Record<string, unknown>,
  now: number = Date.now()
): void {
  const upsert = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  const remove = db.prepare('DELETE FROM settings WHERE key = ?');
  db.exec('BEGIN');
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) remove.run(key);
      else upsert.run(key, JSON.stringify(value), now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
