// API used only by the Windows host agent (Bearer token). The agent polls for work; nothing is pushed.
// MT5 passwords are decrypted here, only for a task this host has claimed, and only sent to that host.

import { HttpError, conflict, notFound, forbidden, decryptSecret, text } from '../util.js';
import { getBytes } from '../storage.js';

const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const POLL_SECONDS = 10;
const aad = (id, userId) => `acct:${id}:${userId}`;

const short = (v, n = 300) => String(v ?? '').slice(0, n);

// Keep only the harmless, expected fields from an account snapshot sent by the agent.
function cleanInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const out = {};
  for (const k of ['balance', 'equity', 'margin', 'freeMargin']) if (Number.isFinite(info[k])) out[k] = info[k];
  for (const k of ['currency', 'company', 'server', 'leverage', 'tradeMode']) if (info[k] !== undefined) out[k] = short(info[k], 60);
  if (typeof info.tradeAllowed === 'boolean') out.tradeAllowed = info.tradeAllowed;
  return out;
}

// Read-only account snapshots (balance, equity, open positions) reported for running sessions.
const SNAPSHOT_MIN_GAP_MS = 30_000;
const SNAPSHOT_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const num = (v) => (Number.isFinite(v) ? v : null);

async function ingestMonitor(ctx, host, monitor) {
  if (!Array.isArray(monitor)) return;
  for (const m of monitor.slice(0, 20)) {
    if (!m || typeof m !== 'object') continue;
    const s = await ctx.db.prepare("SELECT * FROM hosting_sessions WHERE id = ? AND host_id = ? AND status = 'running'").bind(short(m.sessionId, 40), host.id).first();
    if (!s) continue;
    const last = await ctx.db.prepare('SELECT at FROM account_snapshots WHERE account_id = ? ORDER BY at DESC LIMIT 1').bind(s.account_id).first();
    if (last && ctx.now() - last.at < SNAPSHOT_MIN_GAP_MS) continue;
    const positions = (Array.isArray(m.positions) ? m.positions : []).slice(0, 100).map((p) => ({
      ticket: short(p?.ticket, 20), symbol: short(p?.symbol, 24), type: short(p?.type, 10),
      volume: num(p?.volume), openPrice: num(p?.openPrice), profit: num(p?.profit), openedAt: num(p?.openedAt),
    }));
    await ctx.db
      .prepare('INSERT INTO account_snapshots (account_id, session_id, at, balance, equity, margin, free_margin, currency, positions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(s.account_id, s.id, ctx.now(), num(m.balance), num(m.equity), num(m.margin), num(m.freeMargin), short(m.currency, 8), JSON.stringify(positions))
      .run();
    await ctx.db
      .prepare('UPDATE mt5_accounts SET info = ?, info_at = ? WHERE id = ?')
      .bind(JSON.stringify({ balance: num(m.balance), equity: num(m.equity), margin: num(m.margin), freeMargin: num(m.freeMargin), currency: short(m.currency, 8) }), ctx.now(), s.account_id)
      .run();
    await ctx.db.prepare('DELETE FROM account_snapshots WHERE account_id = ? AND at < ?').bind(s.account_id, ctx.now() - SNAPSHOT_KEEP_MS).run();
  }
}

async function requeueStale(ctx, host) {
  const { results } = await ctx.db
    .prepare("SELECT * FROM tasks WHERE host_id = ? AND status = 'claimed' AND claimed_at < ?")
    .bind(host.id, ctx.now() - CLAIM_TIMEOUT_MS)
    .all();
  for (const t of results) {
    if (t.attempts < MAX_ATTEMPTS) {
      await ctx.db.prepare("UPDATE tasks SET status = 'pending' WHERE id = ?").bind(t.id).run();
      if (t.type === 'start_session') {
        await ctx.db.prepare("UPDATE hosting_sessions SET status = 'requested', status_detail = 'Retrying: the host did not finish starting this session.', updated_at = ? WHERE id = ? AND status = 'starting'").bind(ctx.now(), t.session_id).run();
      }
    } else {
      await finishTask(ctx, t, false, 'The host did not report back in time.', null);
    }
  }
}

// Applies a finished task to the session / account it belongs to.
async function finishTask(ctx, task, ok, detail, info) {
  const now = ctx.now();
  detail = short(detail);
  await ctx.db
    .prepare('UPDATE tasks SET status = ?, result = ?, finished_at = ? WHERE id = ?')
    .bind(ok ? 'done' : 'failed', JSON.stringify({ ok, detail }), now, task.id)
    .run();

  if (task.type === 'verify_account') {
    const a = await ctx.db.prepare('SELECT * FROM mt5_accounts WHERE id = ?').bind(task.account_id).first();
    if (!a) return;
    if (ok) {
      await ctx.db
        .prepare("UPDATE mt5_accounts SET status = 'connected', status_detail = ?, verified_at = ?, info = ?, info_at = ?, updated_at = ? WHERE id = ?")
        .bind(detail || 'Login confirmed by the hosting machine.', now, info ? JSON.stringify(info) : null, now, now, a.id)
        .run();
    } else {
      await ctx.db
        .prepare("UPDATE mt5_accounts SET status = 'failed', status_detail = ?, updated_at = ? WHERE id = ?")
        .bind(detail || 'The hosting machine could not log in.', now, a.id)
        .run();
    }
    await ctx.notify({
      userId: a.user_id,
      kind: ok ? 'success' : 'error',
      title: ok ? 'MT5 account verified' : 'MT5 account could not be verified',
      detail: `${a.login}@${a.server}${ok ? '' : ': ' + detail}`,
    });
    await ctx.log(ok ? 'account.verified' : 'account.verify_failed', 'account', a.id, detail, null);
    return;
  }

  const s = await ctx.db.prepare('SELECT * FROM hosting_sessions WHERE id = ?').bind(task.session_id).first();
  if (!s) return;
  if (task.type === 'start_session') {
    if (s.status === 'stop_requested') {
      if (!ok) {
        await ctx.db.prepare("UPDATE tasks SET status = 'cancelled', finished_at = ? WHERE session_id = ? AND type = 'stop_session' AND status = 'pending'").bind(now, s.id).run();
        await ctx.db.prepare("UPDATE hosting_sessions SET status = 'stopped', status_detail = ?, stopped_at = ?, updated_at = ? WHERE id = ?").bind('Stopped.', now, now, s.id).run();
      }
      return; // when ok, the queued stop task will stop it
    }
    if (s.status !== 'starting') return;
    if (ok) {
      await ctx.db
        .prepare("UPDATE hosting_sessions SET status = 'running', status_detail = ?, started_at = ?, last_report_at = ?, updated_at = ? WHERE id = ?")
        .bind(detail || 'Running on the hosting machine.', now, now, now, s.id)
        .run();
    } else {
      await ctx.db
        .prepare("UPDATE hosting_sessions SET status = 'failed', status_detail = ?, updated_at = ? WHERE id = ?")
        .bind(detail || 'The host could not start this session.', now, s.id)
        .run();
    }
    await ctx.notify({ userId: s.user_id, kind: ok ? 'success' : 'error', title: ok ? 'Hosting session running' : 'Hosting session failed to start', detail: ok ? 'Confirmed by the hosting machine.' : detail });
    if (!ok) await ctx.notify({ audience: 'admins', kind: 'error', title: 'Hosting start failed', detail });
    await ctx.log(ok ? 'session.running' : 'session.start_failed', 'session', s.id, detail, null);
  } else if (task.type === 'stop_session') {
    if (ok) {
      await ctx.db.prepare("UPDATE hosting_sessions SET status = 'stopped', status_detail = ?, stopped_at = ?, updated_at = ? WHERE id = ?").bind(detail || 'Stopped.', now, now, s.id).run();
    } else {
      await ctx.db
        .prepare("UPDATE hosting_sessions SET status = 'failed', status_detail = ?, updated_at = ? WHERE id = ?")
        .bind(`The host could not confirm the stop: ${detail}`, now, s.id)
        .run();
      await ctx.notify({ audience: 'admins', kind: 'error', title: 'Hosting stop not confirmed', detail });
    }
    await ctx.log(ok ? 'session.stopped' : 'session.stop_failed', 'session', s.id, detail, null);
  }
}

async function buildPayload(ctx, task) {
  if (task.type === 'stop_session') {
    return { sessionId: task.session_id, accountId: task.account_id };
  }
  const a = await ctx.db.prepare('SELECT * FROM mt5_accounts WHERE id = ?').bind(task.account_id).first();
  if (!a) throw new Error('The MT5 account no longer exists.');
  let pw;
  try {
    pw = await decryptSecret(ctx.env, { ct: a.pw_ct, iv: a.pw_iv }, aad(a.id, a.user_id));
  } catch {
    await ctx.db.prepare("UPDATE mt5_accounts SET status = 'failed', status_detail = ?, updated_at = ? WHERE id = ?").bind('The stored password could not be decrypted (was CREDENTIAL_KEY changed?). Re-enter it.', ctx.now(), a.id).run();
    throw new Error('Stored password could not be decrypted.');
  }
  const account = { id: a.id, login: a.login, server: a.server, password: pw, kind: a.kind };
  if (task.type === 'verify_account') return { account };
  const row = await ctx.db
    .prepare('SELECT s.*, f.filename, f.sha256, f.size, e.name AS ea_name FROM hosting_sessions s JOIN ea_files f ON f.id = s.file_id JOIN eas e ON e.id = s.ea_id WHERE s.id = ?')
    .bind(task.session_id)
    .first();
  if (!row) throw new Error('The session or its file no longer exists.');
  return {
    sessionId: row.id, account, eaName: row.ea_name,
    file: { id: row.file_id, filename: row.filename, sha256: row.sha256, size: row.size },
    config: { symbol: row.symbol, timeframe: row.timeframe, presetName: row.preset_name, preset: row.preset },
  };
}

export const agentRoutes = [
  {
    method: 'POST',
    path: '/agent/poll',
    auth: 'host',
    async handle(ctx) {
      const b = await ctx.body(200_000);
      const host = ctx.host;
      const running = Array.isArray(b.running) ? b.running.slice(0, 200).map((x) => short(x, 40)) : null;
      const info = b.info && typeof b.info === 'object' ? JSON.stringify({ os: short(b.info.os, 80), mt5Found: Boolean(b.info.mt5Found), terminals: Number(b.info.terminals) || 0, simulated: Boolean(b.info.simulated) }) : null;
      await ctx.db.prepare('UPDATE hosts SET last_seen = ?, agent_version = ?, info = ? WHERE id = ?').bind(ctx.now(), short(b.agentVersion, 20), info, host.id).run();

      // Reconcile what the host really runs against what we believe is running.
      if (running) {
        const { results } = await ctx.db.prepare("SELECT * FROM hosting_sessions WHERE host_id = ? AND status = 'running'").bind(host.id).all();
        for (const s of results) {
          if (running.includes(s.id)) {
            await ctx.db.prepare('UPDATE hosting_sessions SET last_report_at = ? WHERE id = ?').bind(ctx.now(), s.id).run();
          } else {
            await ctx.db.prepare("UPDATE hosting_sessions SET status = 'failed', status_detail = ?, updated_at = ? WHERE id = ?").bind('The terminal is no longer running on the hosting machine.', ctx.now(), s.id).run();
            await ctx.notify({ userId: s.user_id, kind: 'error', title: 'Hosting session stopped unexpectedly', detail: 'The terminal is no longer running on the hosting machine.' });
            await ctx.log('session.lost', 'session', s.id, '', null);
          }
        }
      }

      await ingestMonitor(ctx, host, b.monitor);
      await requeueStale(ctx, host);

      // Claim at most one task, atomically.
      for (let tries = 0; tries < 5; tries++) {
        const t = await ctx.db
          .prepare("SELECT * FROM tasks WHERE status = 'pending' AND (host_id = ? OR host_id IS NULL) ORDER BY created_at, rowid LIMIT 1")
          .bind(host.id)
          .first();
        if (!t) break;
        const claimed = await ctx.db
          .prepare("UPDATE tasks SET status = 'claimed', host_id = ?, claimed_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'")
          .bind(host.id, ctx.now(), t.id)
          .run();
        if (claimed.meta.changes !== 1) continue;
        if (t.type === 'start_session') {
          const s = await ctx.db.prepare('SELECT * FROM hosting_sessions WHERE id = ?').bind(t.session_id).first();
          if (!s || s.desired !== 'running' || s.status !== 'requested') {
            await ctx.db.prepare("UPDATE tasks SET status = 'cancelled', finished_at = ? WHERE id = ?").bind(ctx.now(), t.id).run();
            continue;
          }
          await ctx.db.prepare("UPDATE hosting_sessions SET status = 'starting', status_detail = ?, host_id = ?, updated_at = ? WHERE id = ?").bind('The hosting machine is starting the terminal.', host.id, ctx.now(), s.id).run();
        }
        try {
          return { task: { id: t.id, type: t.type, ...(await buildPayload(ctx, t)) }, pollSeconds: POLL_SECONDS };
        } catch (err) {
          await finishTask(ctx, t, false, err.message, null);
          continue;
        }
      }
      return { task: null, pollSeconds: POLL_SECONDS };
    },
  },

  {
    method: 'POST',
    path: '/agent/tasks/:id/result',
    auth: 'host',
    async handle(ctx) {
      const b = await ctx.body(10_000);
      const t = await ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').bind(ctx.params.id).first();
      if (!t || t.host_id !== ctx.host.id) throw notFound('Task not found.');
      if (t.status !== 'claimed') throw conflict('That task is not waiting for a result.');
      if (typeof b.ok !== 'boolean') throw new HttpError(400, 'bad_request', '"ok" must be true or false.');
      await ctx.db.prepare('UPDATE hosts SET last_seen = ? WHERE id = ?').bind(ctx.now(), ctx.host.id).run();
      await finishTask(ctx, t, b.ok, b.detail, cleanInfo(b.info));
      return {};
    },
  },

  // The EX5 for a session this host has claimed. Not available for any other file.
  {
    method: 'GET',
    path: '/agent/files/:fileId',
    auth: 'host',
    async handle(ctx) {
      const row = await ctx.db
        .prepare(
          `SELECT f.* FROM ea_files f
             JOIN hosting_sessions s ON s.file_id = f.id
             JOIN tasks t ON t.session_id = s.id
            WHERE f.id = ? AND t.host_id = ? AND t.type = 'start_session' AND t.status = 'claimed' LIMIT 1`,
        )
        .bind(ctx.params.fileId, ctx.host.id)
        .first();
      if (!row) throw notFound('File not available.');
      const bytes = await getBytes(ctx.env, ctx.db, row);
      return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'x-sha256': row.sha256 } });
    },
  },
];
