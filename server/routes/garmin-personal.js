import { Router } from 'express';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import {
  connectPersonalApi,
  personalStatus,
  personalGet,
  importActivities,
  disconnectPersonalApi,
} from '../lib/garmin-personal.js';

import {
  importDailyEnergy,
  personalImportOptions,
  savePersonalImportOptions,
  readStoredDailyEnergy,
  personalBudgetOptions,
  savePersonalBudgetOptions,
  validateEnergyRange,
} from '../lib/garmin-personal-energy.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : 0;

router.get('/status', wrap((req, res) => {
  const userId = uid(req);
  res.json({
    ...personalStatus(userId),
    importOptions: personalImportOptions(userId),
    budgetOptions: personalBudgetOptions(userId),
  });
}));

router.get('/data', wrap((req, res) => {
  res.json(readStoredDailyEnergy(uid(req), req.query.date));
}));

router.post('/budget-options', wrap((req, res) => {
  const budgetOptions = savePersonalBudgetOptions(uid(req), req.body);
  res.json({ ok: true, budgetOptions });
}));

router.post('/import-options', wrap((req, res) => {
  const importOptions = savePersonalImportOptions(uid(req), req.body);
  res.json({ ok: true, importOptions });
}));

router.post('/connect', wrap(async (req, res) => {
  const { apiKey } = req.body || {};
  const result = await connectPersonalApi(uid(req), apiKey);
  res.json({ ok: true, ...result });
}));

router.post('/sync', wrap(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const from = req.body?.from || req.body?.date || today;
  const to = req.body?.to || req.body?.date || today;

  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T23:59:59Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return res.status(400).json({ error: 'Invalid date range' });
  }
  if ((end - start) / 86_400_000 > 365) {
    return res.status(400).json({ error: 'Range cannot exceed 365 days' });
  }

  const userId = uid(req);
  const options = personalImportOptions(userId);
  if (!options.activities && !options.energy) {
    return res.status(400).json({ error: 'Select at least one import category' });
  }

  // Validate energy limits before either category makes an upstream request.
  if (options.energy) validateEnergyRange(from, to);

  // Categories commit independently. Report partial success explicitly so
  // an energy failure does not hide an already completed activity import.
  const categories = {};
  let successful = 0;

  if (options.activities) {
    try {
      categories.activities = {
        ok: true,
        ...await importActivities(userId, from, to),
      };
      successful++;
    } catch {
      categories.activities = {
        ok: false,
        error: 'Activity import failed',
      };
    }
  }

  if (options.energy) {
    try {
      categories.energy = {
        ok: true,
        ...await importDailyEnergy(userId, from, to),
      };
      successful++;
    } catch {
      categories.energy = {
        ok: false,
        error: 'Daily-energy import failed',
      };
    }
  }

  const activities = categories.activities;
  const activityErrors = activities?.errors || [];
  const categoryErrors = Object.values(categories)
    .filter(category => !category.ok)
    .map(category => category.error);
  const errors = [...activityErrors, ...categoryErrors];

  res.status(successful ? 200 : 502).json({
    ok: errors.length === 0,
    partial: successful > 0 && errors.length > 0,
    from,
    to,
    // Preserve the current selected-day UI's activity response fields.
    imported: activities?.imported ?? 0,
    total: activities?.total ?? 0,
    errors,
    categories,
  });
}));

router.get('/activities', wrap(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const from = req.query.from || req.query.date || today;
  const to = req.query.to || req.query.date || today;

  // NOTE: Pagination is not implemented yet; this returns only the first page.
  const activities = await personalGet(uid(req), '/activitylist-service/activities/search/activities', {
    startDate: from,
    endDate: to,
  });

  res.json(Array.isArray(activities) ? activities : (activities.activities || activities.results || []));
}));

router.delete('/disconnect', wrap((req, res) => {
  disconnectPersonalApi(uid(req));
  res.json({ ok: true });
}));

export default router;
