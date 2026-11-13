import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import {
  connectPersonalApi,
  personalStatus,
  personalGet,
  importActivities,
  disconnectPersonalApi,
} from '../lib/garmin-personal.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : 0;

router.get('/status', wrap((req, res) => {
  res.json(personalStatus(uid(req)));
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

  const result = await importActivities(uid(req), from, to);
  res.json({ ok: true, from, to, ...result });
}));

router.get('/activities', wrap(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const from = req.query.from || req.query.date || today;
  const to = req.query.to || req.query.date || today;

  const activities = await personalGet(uid(req), '/activity-service/search/activities', {
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
