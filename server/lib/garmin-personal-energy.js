import { personalGet } from './garmin-personal.js';
import db from '../db.js';

const DAILY_SUMMARIES_PATH = '/usersummary-service/v2/dailysummaries';
const DAY_MS = 86_400_000;

// Conservative initial request limit, not a claim about Garmin's API limit.
const MAX_DAYS = 31;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function badResponse(message) {
  return Object.assign(new Error(message), { status: 502 });
}

export function validateEnergyRange(from, to) {
  const parseDate = value => {
    if (typeof value !== 'string' ||
        !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) {
      throw badRequest('Dates must be YYYY-MM-DD');
    }
    const ms = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(ms) ||
        new Date(ms).toISOString().slice(0, 10) !== value) {
      throw badRequest('Invalid calendar date');
    }
    return ms;
  };

  const start = parseDate(from);
  const end = parseDate(to);
  const days = (end - start) / DAY_MS + 1;
  if (days < 1 || days > MAX_DAYS) {
    throw badRequest(`Range must contain 1 to ${MAX_DAYS} days`);
  }
  return { from, to, days };
}

export function normalizeDailyEnergy(payload, from, to) {
  validateEnergyRange(from, to);
  if (!payload || !Array.isArray(payload.data)) {
    throw badResponse('Unexpected Garmin daily-summary response');
  }

  const dates = new Set();
  const records = [];

  for (const day of payload.data) {
    const date = day?.calendarDate;
    try {
      validateEnergyRange(date, date);
    } catch {
      throw badResponse('Garmin returned an invalid summary date');
    }
    if (date < from || date > to || dates.has(date)) {
      throw badResponse('Garmin returned an out-of-range or duplicate date');
    }
    dates.add(date);

    const metrics = {};
    const fields = [
      ['burnedResting', 'resting_calories'],
      ['burnedActive', 'active_calories'],
      ['burnedTotal', 'calories_out'],
    ];

    for (const [field, metric] of fields) {
      const value = day?.calories?.[field];
      // Missing data stays missing; never convert null to zero.
      if (value == null) continue;
      if (typeof value !== 'number' ||
          !Number.isFinite(value) || value < 0) {
        throw badResponse('Garmin returned an invalid energy value');
      }
      metrics[metric] = value;
    }

    if (Object.keys(metrics).length) {
      records.push({ date, source: 'garmin_personal', metrics });
    }
  }

  return records.sort((a, b) => a.date.localeCompare(b.date));
}

// Preview only: no wellness_data writes and no budget changes.
// Existing credential handling may refresh the cached access token.
export async function previewDailyEnergy(userId, from, to) {
  const range = validateEnergyRange(from, to);
  const payload = await personalGet(userId, DAILY_SUMMARIES_PATH, {
    startDate: from,
    endDate: to,
  });
  const records = normalizeDailyEnergy(payload, from, to);
  return {
    dryRun: true,
    from,
    to,
    requestedDays: range.days,
    returnedDays: payload.data.length,
    energyDays: records.length,
    metricRows: records.reduce(
      (count, record) => count + Object.keys(record.metrics).length, 0
    ),
    records,
  };
}


function readImportPreference(userId, key, fallback) {
  const row = db.prepare(`
    SELECT value FROM user_settings
    WHERE user_id = ? AND key = ? AND deleted_at IS NULL
  `).get(userId ?? 0, key);
  if (!row || row.value == null) return fallback;
  try {
    const value = JSON.parse(row.value);
    return typeof value === 'boolean' ? value : fallback;
  } catch {
    return fallback;
  }
}

export function personalImportOptions(userId) {
  return {
    activities: readImportPreference(
      userId, 'garminPersonalImportActivities', true
    ),
    energy: readImportPreference(
      userId, 'garminPersonalImportEnergy', false
    ),
  };
}

function requireEnergyImport(userId) {
  if (!personalImportOptions(userId).energy) {
    throw Object.assign(
      new Error('Garmin Personal daily-energy import is disabled'),
      { status: 403 }
    );
  }
}

export async function importDailyEnergy(userId, from, to) {
  requireEnergyImport(userId);
  const preview = await previewDailyEnergy(userId, from, to);

  const upsert = db.prepare(`
    INSERT INTO wellness_data
      (user_id, date, source, metric_type, value, metadata, synced_at)
    VALUES (?, ?, 'garmin_personal', ?, ?, '{}', datetime('now'))
    ON CONFLICT(user_id, date, source, metric_type) DO UPDATE SET
      value = excluded.value,
      synced_at = excluded.synced_at
  `);

  let written = 0;
  db.transaction(() => {
    // Consent may have changed while the upstream request was pending.
    requireEnergyImport(userId);
    for (const record of preview.records) {
      for (const [metric, value] of Object.entries(record.metrics)) {
        upsert.run(userId ?? 0, record.date, metric, value);
        written++;
      }
    }
  })();

  return {
    importedDays: preview.energyDays,
    returnedDays: preview.returnedDays,
    metricRows: written,
  };
}


export function savePersonalImportOptions(userId, options) {
  if (!options || typeof options.activities !== 'boolean' ||
      typeof options.energy !== 'boolean') {
    throw Object.assign(
      new Error('activities and energy must both be booleans'),
      { status: 400 }
    );
  }

  const upsert = db.prepare(`
    INSERT INTO user_settings (user_id, key, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `);

  db.transaction(() => {
    upsert.run(
      userId ?? 0, 'garminPersonalImportActivities',
      JSON.stringify(options.activities)
    );
    upsert.run(
      userId ?? 0, 'garminPersonalImportEnergy',
      JSON.stringify(options.energy)
    );
  })();

  return personalImportOptions(userId);
}


// Read imported data independently of current connection/import permission.
// Disabling future imports does not delete or hide historical records.
export function readStoredDailyEnergy(userId, date) {
  validateEnergyRange(date, date);
  const rows = db.prepare(`
    SELECT metric_type, value FROM wellness_data
    WHERE user_id = ? AND date = ? AND source = 'garmin_personal'
      AND metric_type IN (
        'resting_calories', 'active_calories', 'calories_out'
      )
  `).all(userId ?? 0, date);

  const metrics = {};
  for (const row of rows) {
    if (typeof row.value === 'number' &&
        Number.isFinite(row.value) && row.value >= 0) {
      metrics[row.metric_type] = row.value;
    }
  }
  return Object.keys(metrics).length ? { [date]: metrics } : {};
}


export function personalBudgetOptions(userId) {
  return {
    useEnergyForBudget: readImportPreference(
      userId, 'garminPersonalUseEnergyForBudget', false
    ),
  };
}

export function savePersonalBudgetOptions(userId, options) {
  if (!options || typeof options.useEnergyForBudget !== 'boolean') {
    throw badRequest('useEnergyForBudget must be a boolean');
  }

  db.prepare(`
    INSERT INTO user_settings (user_id, key, value, updated_at)
    VALUES (?, 'garminPersonalUseEnergyForBudget', ?, datetime('now'))
    ON CONFLICT(user_id, key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `).run(userId ?? 0, JSON.stringify(options.useEnergyForBudget));

  return personalBudgetOptions(userId);
}
