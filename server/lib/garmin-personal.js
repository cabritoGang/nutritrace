import db from '../db.js';
import { encrypt, decrypt } from './token-crypto.js';
import { logger } from '../logger.js';

const PERSONAL_BASE = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const ACTIVITY_SEARCH_PATH = '/activitylist-service/activities/search/activities';

// Personal API credentials are separate from the legacy Garmin Health API
// OAuth 1.0a tokens. The API key is encrypted at rest; the short-lived
// bearer token is cached until shortly before its expiry.
db.exec(`
  CREATE TABLE IF NOT EXISTS garmin_personal_tokens (
    user_id               INTEGER PRIMARY KEY,
    api_key_encrypted     TEXT NOT NULL,
    access_token_encrypted TEXT,
    token_expires_at      TEXT,
    created_at            TEXT DEFAULT (datetime('now')),
    updated_at            TEXT DEFAULT (datetime('now'))
  );
`);

function _row(userId) {
  return db.prepare('SELECT * FROM garmin_personal_tokens WHERE user_id = ?').get(userId);
}

function _saveToken(userId, apiKeyEncrypted, accessToken, expiresAt) {
  db.prepare(`
    INSERT INTO garmin_personal_tokens
      (user_id, api_key_encrypted, access_token_encrypted, token_expires_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      api_key_encrypted = excluded.api_key_encrypted,
      access_token_encrypted = excluded.access_token_encrypted,
      token_expires_at = excluded.token_expires_at,
      updated_at = excluded.updated_at
  `).run(userId, apiKeyEncrypted, accessToken ? encrypt(accessToken) : null, expiresAt || null);
}

async function _exchangeToken(apiKey) {
  const response = await fetch(`${PERSONAL_BASE}${TOKEN_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `ApiKey ${apiKey}`,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Garmin Personal API token exchange failed (${response.status}): ${body.slice(0, 200)}`);
  }

  // Garmin returns the bearer token as plain text (a JWT), not JSON.
  const accessToken = (await response.text()).trim();
  if (!accessToken) throw new Error('Garmin Personal API token response did not include an access token');

  // Garmin does not return a machine-readable expiry with the plain-text
  // token. Cache it for 23 hours, leaving an hour of safety margin before
  // the documented 24-hour token lifetime ends.
  const expiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();

  return { accessToken, expiresAt };
}

export async function connectPersonalApi(userId, apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
    throw Object.assign(new Error('A valid Garmin Personal API key is required'), { status: 400 });
  }

  const { accessToken, expiresAt } = await _exchangeToken(apiKey.trim());
  _saveToken(userId, encrypt(apiKey.trim()), accessToken, expiresAt);
  return { connected: true, tokenExpiresAt: expiresAt };
}

async function _getAccessToken(userId) {
  const row = _row(userId);
  if (!row) throw Object.assign(new Error('Garmin Personal API is not connected'), { status: 401 });

  const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
  if (row.access_token_encrypted && expiresAt > Date.now() + 60_000) {
    return decrypt(row.access_token_encrypted);
  }

  const apiKey = decrypt(row.api_key_encrypted);
  const { accessToken, expiresAt: newExpiresAt } = await _exchangeToken(apiKey);
  _saveToken(userId, row.api_key_encrypted, accessToken, newExpiresAt);
  return accessToken;
}

export async function personalGet(userId, path, queryParams = {}) {
  const accessToken = await _getAccessToken(userId);
  const qs = new URLSearchParams(queryParams).toString();
  const url = `${PERSONAL_BASE}${path}${qs ? `?${qs}` : ''}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (response.status === 401) {
    db.prepare("UPDATE garmin_personal_tokens SET access_token_encrypted = NULL, token_expires_at = NULL, updated_at = datetime('now') WHERE user_id = ?").run(userId);
    throw Object.assign(new Error('Garmin Personal API access token was rejected — reconnect or provide a new API key'), { status: 401 });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Garmin Personal API request failed (${response.status}): ${body.slice(0, 200)}`);
  }

  return response.json();
}

function _pick(object, keys) {
  for (const key of keys) {
    if (object?.[key] != null) return object[key];
  }
  return null;
}

function _activityDate(activity) {
  const raw = _pick(activity, ['startTimeGMT', 'startTimeLocal', 'startTime', 'beginTimestamp', 'startLocalDateTime']);
  if (!raw) return new Date().toISOString().slice(0, 10);
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function _activitySourceId(activity) {
  return String(_pick(activity, ['activityId', 'id', 'activityUUID', 'uuid']) || '');
}

function _mapActivity(activity) {
  const startTime = _pick(activity, ['startTimeGMT', 'startTimeLocal', 'startTime', 'beginTimestamp', 'startLocalDateTime']);
  const durationSeconds = _pick(activity, ['durationInSeconds', 'duration', 'elapsedDurationInSeconds', 'elapsedTimeSec']);
  const distanceMeters = _pick(activity, ['distanceInMeters', 'distance', 'totalDistanceInMeters', 'totalDistance']);
  const calories = _pick(activity, ['calories', 'kcalories', 'energyKcal', 'activeKilocalories']);
  const activityType = _pick(activity, ['activityType', 'activityTypeKey', 'sportType', 'type']);
  const activityName = _pick(activity, ['activityName', 'name', 'title']);

  return {
    sourceId: _activitySourceId(activity),
    date: _activityDate(activity),
    activityType: typeof activityType === 'string' ? activityType : (activityType?.typeKey || activityType?.display || null),
    activityName: activityName || null,
    startTime: startTime ? new Date(startTime).toISOString() : null,
    durationMs: durationSeconds != null ? Math.round(Number(durationSeconds) * 1000) : null,
    distanceKm: distanceMeters != null ? +(Number(distanceMeters) / 1000).toFixed(2) : null,
    calories: calories != null ? Math.round(Number(calories)) : null,
    avgHr: _pick(activity, ['averageHR', 'averageHeartRateInBeatsPerMinute', 'averageHeartRate', 'avgHr', 'avgHeartRate']),
    maxHr: _pick(activity, ['maxHR', 'maxHeartRateInBeatsPerMinute', 'maxHeartRate', 'maxHr', 'maxHeartRate']),
    steps: _pick(activity, ['steps', 'stepCount', 'totalSteps']),
    hasGps: Boolean(_pick(activity, ['hasGps', 'hasPolyline', 'gpsData'])),
  };
}

export async function importActivities(userId, fromDate, toDate) {
  // NOTE: Pagination is not implemented yet. This currently imports only the
  // first page returned by Garmin. Do not present this as a complete history
  // import until pagination is added and tested.
  const data = await personalGet(userId, ACTIVITY_SEARCH_PATH, {
    startDate: fromDate,
    endDate: toDate,
  });

  const activities = Array.isArray(data)
    ? data
    : (data.activities || data['activity-search'] || data.results || []);

  const upsert = db.prepare(`
    INSERT INTO workouts
      (user_id, source, source_id, date, activity_type, activity_name, start_time,
       duration_ms, distance_km, calories, avg_hr, max_hr, steps, has_gps, gps_data,
       synced_at, updated_at)
    VALUES (?, 'garmin_personal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'), datetime('now'))
    ON CONFLICT(user_id, source, source_id) DO UPDATE SET
      date = excluded.date,
      activity_type = excluded.activity_type,
      activity_name = excluded.activity_name,
      start_time = excluded.start_time,
      duration_ms = excluded.duration_ms,
      distance_km = excluded.distance_km,
      calories = excluded.calories,
      avg_hr = excluded.avg_hr,
      max_hr = excluded.max_hr,
      steps = excluded.steps,
      has_gps = excluded.has_gps,
      synced_at = excluded.synced_at,
      updated_at = excluded.updated_at
  `);

  let imported = 0;
  const errors = [];

  db.transaction(() => {
    for (const activity of activities) {
      try {
        const mapped = _mapActivity(activity);
        if (!mapped.sourceId) {
          errors.push('Skipped an activity without an ID');
          continue;
        }
        upsert.run(
          userId, mapped.sourceId, mapped.date, mapped.activityType, mapped.activityName,
          mapped.startTime, mapped.durationMs, mapped.distanceKm, mapped.calories,
          mapped.avgHr, mapped.maxHr, mapped.steps, mapped.hasGps ? 1 : 0
        );
        imported++;
      } catch (error) {
        errors.push(error.message);
        logger.warn('[garmin-personal] activity import failed:', error.message);
      }
    }
  })();

  return { imported, total: activities.length, errors };
}

export function personalStatus(userId) {
  const row = _row(userId);
  const lastSync = db.prepare(
    "SELECT MAX(synced_at) AS ts FROM workouts WHERE user_id = ? AND source = 'garmin_personal'"
  ).get(userId);

  return {
    connected: Boolean(row?.api_key_encrypted),
    tokenExpiresAt: row?.token_expires_at || null,
    lastSyncedAt: lastSync?.ts || null,
  };
}

export function disconnectPersonalApi(userId) {
  db.prepare('DELETE FROM garmin_personal_tokens WHERE user_id = ?').run(userId);
}
