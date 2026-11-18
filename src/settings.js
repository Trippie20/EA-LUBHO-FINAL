// Platform settings stored in D1 (Super Admin can change them). A setting that was never saved
// falls back to an environment default so a fresh deployment starts in a safe state.

export async function getSetting(ctx, key) {
  const row = await ctx.db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

export async function setSetting(ctx, key, value) {
  await ctx.db
    .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, String(value), ctx.now())
    .run();
}

// New accounts wait for Super Admin approval when this is on.
export async function approvalRequired(ctx) {
  const saved = await getSetting(ctx, 'require_approval');
  if (saved !== null) return saved === 'true';
  return ctx.env.REQUIRE_APPROVAL_DEFAULT === 'true';
}
