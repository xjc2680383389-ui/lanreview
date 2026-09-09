import { AppError, hmac, timingSafeEqual } from './util.js';
import { clientAddress, isLoopback } from './net.js';

const CREATOR_COOKIE = 'lr_creator';
export const DEFAULT_LINK_TTL_MS = 6 * 60 * 60 * 1000;

export function creatorTokenFromRequest(req) {
  const header = req.headers['x-lr-creator'];
  if (typeof header === 'string' && header) return header.trim();
  const cookie = String(req.headers.cookie || '');
  const m = new RegExp(`(?:^|; )${CREATOR_COOKIE}=([^;]+)`).exec(cookie);
  if (m) return decodeURIComponent(m[1]);
  const url = new URL(req.url, 'http://x');
  return url.searchParams.get('ck') || '';
}

export function isCreatorRequest(app, req) {
  const token = creatorTokenFromRequest(req);
  if (token && timingSafeEqual(token, app.cfg.creatorToken)) return true;
  return isLoopback(clientAddress(req));
}

export function creatorCookie(cfg) {
  return `${CREATOR_COOKIE}=${encodeURIComponent(cfg.creatorToken)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

/** Loopback requests get the creator token injected so the console works without a login step. */
export function creatorBootstrapPayload(app, req) {
  const loop = isLoopback(clientAddress(req));
  return {
    loopback: loop,
    creatorToken: loop ? app.cfg.creatorToken : null,
    hostName: app.cfg.hostName,
    appName: app.appName,
    appVersion: app.appVersion,
  };
}

export function signLink(app, { scope, deviceId, ttlMs = DEFAULT_LINK_TTL_MS, extra = '' }) {
  const exp = Date.now() + ttlMs;
  const sig = hmac(app.cfg.hostSecret, `${scope}|${deviceId}|${exp}|${extra}`);
  return { d: deviceId, e: exp, s: sig };
}

export function verifyLink(app, { scope, query, deviceId, extra = '' }) {
  const d = query.get('d');
  const e = query.get('e');
  const s = query.get('s');
  if (!d || !e || !s) return false;
  if (d !== deviceId) return false;
  if (!Number.isFinite(Number(e)) || Number(e) < Date.now()) return false;
  const expected = hmac(app.cfg.hostSecret, `${scope}|${deviceId}|${e}|${extra}`);
  return timingSafeEqual(expected, s);
}

/**
 * Authenticate a paired device. Reads the token from the header, query (`t`) or
 * JSON body, so <img>/<video> tags and the receiver agent can both call APIs.
 */
export function deviceFromRequest(app, req, { requireApproved = true, capability = null } = {}) {
  const url = new URL(req.url, 'http://x');
  let token = req.headers['x-lr-device-token'];
  if (!token) token = url.searchParams.get('t');
  if (typeof token !== 'string' || !token) {
    throw new AppError('device_unpaired', '设备尚未配对，请扫码或输入配对码', 401);
  }
  const device = getDeviceByToken(app, token);
  if (!device) throw new AppError('device_unpaired', '设备配对信息无效，请重新配对', 401);
  if (device.status === 'revoked') throw new AppError('device_revoked', '创作者已取消该设备的授权', 403);
  if (requireApproved && device.status !== 'approved') {
    throw new AppError('device_pending', '等待创作者在本机确认授权', 403, { pending: true, deviceId: device.id });
  }
  if (capability === 'review' && !['reviewer', 'both'].includes(device.role)) {
    throw new AppError('device_wrong_role', '该设备未被授权为审核设备', 403);
  }
  if (capability === 'receive' && !(device.can_receive || ['receiver', 'both'].includes(device.role))) {
    throw new AppError('device_wrong_role', '该设备未被授权接收文件', 403);
  }
  return device;
}

let tokenIndex = { at: 0, list: null };

function getDeviceByToken(app, token) {
  const db = app.db;
  if (!db) return null;
  const row = db.prepare('SELECT * FROM devices WHERE token = ?').get(token);
  return row || null;
}

function allDevicesByToken() {
  return [];
}
