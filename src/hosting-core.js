// Shared hosting logic used by the user, admin and agent routes.

import { newId, badRequest } from './util.js';

export const HOST_ONLINE_MS = 90_000;
export const ACTIVE_STATES = ['requested', 'starting', 'running', 'stop_requested'];

export const hostOnline = (host, now) => Boolean(host?.last_seen) && now - host.last_seen <= HOST_ONLINE_MS;

// Chooses the online host with the fewest sessions. If none is online, the host seen most
// recently (the session then waits, honestly, until that host's agent connects).
export async function pickHost(ctx) {
  const { results } = await ctx.db
    .prepare(
      `SELECT h.*, (SELECT COUNT(*) FROM hosting_sessions s
                     WHERE s.host_id = h.id AND s.status IN ('requested','starting','running')) AS load
         FROM hosts h`,
    )
    .all();
  if (!results.length) return null;
  const now = ctx.now();
  const online = results.filter((h) => hostOnline(h, now)).sort((a, b) => a.load - b.load);
  if (online.length) return online[0];
  return [...results].sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0))[0];
}

export async function createTask(ctx, { type, hostId = null, userId = null, accountId = null, sessionId = null }) {
  const id = newId();
  await ctx.db
    .prepare('INSERT INTO tasks (id, type, host_id, user_id, account_id, session_id, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
    .bind(id, type, hostId, userId, accountId, sessionId, 'pending', ctx.now())
    .run();
  return id;
}

// The status a person should be shown. A "running" session is only trusted while its host is
// reporting in; if the host has gone quiet the honest answer is "unknown".
export function sessionView(row, host, now) {
  const online = hostOnline(host, now);
  let status = row.status;
  let detail = row.status_detail || '';
  if ((row.status === 'running' || row.status === 'starting' || row.status === 'stop_requested') && host && !online) {
    status = 'unknown';
    detail = 'The hosting machine has not reported in recently, so the real state is not known.';
  } else if (row.status === 'requested' && host && !online) {
    detail = 'Waiting for the hosting machine to come online.';
  } else if (row.status === 'requested' && !host) {
    detail = 'No hosting machine is assigned.';
  }
  return {
    id: row.id,
    eaId: row.ea_id,
    eaName: row.ea_name ?? null,
    eaVersion: row.ea_version ?? null,
    fileId: row.file_id,
    fileName: row.file_name ?? null,
    accountId: row.account_id,
    accountLabel: row.account_label ?? null,
    accountLogin: row.account_login ?? null,
    hostId: row.host_id,
    hostName: row.host_name ?? null,
    hostOnline: host ? online : false,
    symbol: row.symbol ?? '',
    timeframe: row.timeframe ?? 'M1',
    presetName: row.preset_name ?? '',
    hasPreset: Boolean(row.preset),
    desired: row.desired,
    status,
    reportedStatus: row.status,
    detail,
    lastReportAt: row.last_report_at,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    createdAt: row.created_at,
    userEmail: row.user_email ?? undefined,
  };
}

// Asks for a session to stop. If the agent never picked the start task up, it is simply
// cancelled; otherwise a stop task is queued for the agent and the status becomes
// "stop_requested" until the agent confirms.
export async function requestStop(ctx, s, reason = '') {
  const now = ctx.now();
  if (s.status === 'stopped' || s.status === 'failed') {
    await ctx.db.prepare("UPDATE hosting_sessions SET desired = 'stopped', updated_at = ? WHERE id = ?").bind(now, s.id).run();
    return 'stopped';
  }
  if (s.status === 'stop_requested') return 'stop_requested';
  if (s.status === 'requested') {
    const cancelled = await ctx.db
      .prepare("UPDATE tasks SET status = 'cancelled', finished_at = ? WHERE session_id = ? AND type = 'start_session' AND status = 'pending'")
      .bind(now, s.id)
      .run();
    if (cancelled.meta.changes > 0) {
      await ctx.db
        .prepare("UPDATE hosting_sessions SET desired = 'stopped', status = 'stopped', status_detail = ?, stopped_at = ?, updated_at = ? WHERE id = ?")
        .bind(reason || 'Stopped before the host picked it up.', now, now, s.id)
        .run();
      return 'stopped';
    }
    // The agent claimed it a moment ago: fall through to a normal stop request.
  }
  await ctx.db
    .prepare("UPDATE hosting_sessions SET desired = 'stopped', status = 'stop_requested', status_detail = ?, updated_at = ? WHERE id = ?")
    .bind(reason || 'Stop requested. Waiting for the host to confirm.', now, s.id)
    .run();
  await createTask(ctx, { type: 'stop_session', hostId: s.host_id, userId: s.user_id, accountId: s.account_id, sessionId: s.id });
  return 'stop_requested';
}

export async function stopAllForUser(ctx, userId, reason) {
  const { results } = await ctx.db
    .prepare(`SELECT * FROM hosting_sessions WHERE user_id = ? AND status IN ('requested','starting','running')`)
    .bind(userId)
    .all();
  for (const s of results) await requestStop(ctx, s, reason);
  return results.length;
}

export async function activeSessionCount(ctx, whereSql, value) {
  const row = await ctx.db
    .prepare(`SELECT COUNT(*) AS c FROM hosting_sessions WHERE ${whereSql} AND status IN ('requested','starting','running','stop_requested')`)
    .bind(value)
    .first();
  return row?.c ?? 0;
}

export const TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN1'];

// Hosting configuration for a session: what the host passes to MetaTrader when it starts the EA.
// The platform stores and forwards these values only; it never places trades itself.
export function parseConfig(body, current = {}) {
  const out = {
    symbol: current.symbol ?? '',
    timeframe: current.timeframe ?? 'M1',
    preset_name: current.preset_name ?? '',
    preset: current.preset ?? '',
  };
  if (body.symbol !== undefined) {
    const v = String(body.symbol).trim();
    if (v && !/^[A-Za-z0-9._#@-]{1,24}$/.test(v)) throw badRequest('Symbol may only contain letters, numbers and . _ # @ - (max 24).');
    out.symbol = v;
  }
  if (body.timeframe !== undefined) {
    const v = String(body.timeframe).toUpperCase();
    if (!TIMEFRAMES.includes(v)) throw badRequest(`Timeframe must be one of ${TIMEFRAMES.join(', ')}.`);
    out.timeframe = v;
  }
  if (body.preset !== undefined) {
    const v = String(body.preset);
    if (v.length > 20_000) throw badRequest('The preset (.set) text is too long (max 20 000 characters).');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(v)) throw badRequest('The preset contains characters that are not allowed.');
    out.preset = v;
    if (!v) out.preset_name = '';
  }
  if (body.presetName !== undefined && out.preset) {
    const n = String(body.presetName).trim() || 'preset.set';
    if (!/^[A-Za-z0-9._ -]{1,60}$/.test(n)) throw badRequest('The preset file name may only contain letters, numbers, spaces and . _ -');
    out.preset_name = n.toLowerCase().endsWith('.set') ? n : `${n}.set`;
  } else if (out.preset && !out.preset_name) {
    out.preset_name = 'preset.set';
  }
  return out;
}
