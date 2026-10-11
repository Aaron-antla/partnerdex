import express from 'express';
import { getDb } from '../db/index.js';
import {
  describe,
  MixpanelError,
  readConnection,
  readSettings,
  removeConnection,
  saveConnection,
  saveSettings,
} from '../mixpanel/connection.js';
import { checkConnection, syncUsage } from '../mixpanel/ingest.js';
import { sendError } from './errors.js';

/**
 * The Mixpanel settings API: the service account, and the cost model the
 * Multipliers page prices usage with. The secret goes in and never comes out.
 */
export function mixpanelRouter(): express.Router {
  const router = express.Router();

  const payload = () => {
    const db = getDb();
    const connection = readConnection(db);
    const stats = db
      .prepare(
        `SELECT COUNT(DISTINCT domain) AS shops, MIN(day) AS earliest, MAX(day) AS latest,
                COALESCE(SUM(generations), 0) AS generations
           FROM shop_usage_daily`,
      )
      .get() as { shops: number; earliest: string | null; latest: string | null; generations: number };
    const profiles = (db.prepare('SELECT COUNT(*) AS n FROM mixpanel_identities').get() as { n: number }).n;
    return {
      connection: connection ? describe(connection) : null,
      settings: readSettings(db),
      stats: { ...stats, profiles },
    };
  };

  const text = (body: unknown, key: string): string | undefined => {
    const value = (body as Record<string, unknown> | undefined)?.[key];
    return typeof value === 'string' ? value : undefined;
  };

  router.get('/', (_request, response) => {
    try {
      response.json(payload());
    } catch (error) {
      sendError(response, error);
    }
  });

  router.put('/', (request, response) => {
    try {
      saveConnection({
        projectId: text(request.body, 'projectId') ?? '',
        region: text(request.body, 'region') ?? '',
        username: text(request.body, 'username') ?? '',
        // Absent on an edit that keeps the stored secret.
        secret: text(request.body, 'secret'),
      });
      response.json(payload());
    } catch (error) {
      sendError(response, error);
    }
  });

  router.delete('/', (_request, response) => {
    try {
      if (!removeConnection()) {
        response.status(404).json({ error: 'Mixpanel is not connected.' });
        return;
      }
      // Usage already collected stays: disconnecting is not a request to
      // forget a month of history.
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  router.put('/settings', (request, response) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const number = (key: string): number | undefined => {
        const value = body[key];
        if (value === undefined || value === null || value === '') return undefined;
        const parsed = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(parsed)) throw new MixpanelError(`${key} must be a number.`);
        return parsed;
      };
      const list = (key: string): string[] | string | undefined => {
        const value = body[key];
        return typeof value === 'string' || Array.isArray(value) ? (value as string[] | string) : undefined;
      };
      saveSettings({
        costPerGeneration: number('costPerGeneration'),
        costPerPayingShop: number('costPerPayingShop'),
        generationEvents: list('generationEvents'),
        excludedDomains: list('excludedDomains'),
      });
      response.json(payload());
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/check', (_request, response) => {
    checkConnection(getDb())
      .then((check) => response.json({ check, ...payload() }))
      .catch((error: unknown) => sendError(response, error));
  });

  /** Pulls usage now. `full` re-reads the whole backfill window. */
  router.post('/sync', (request, response) => {
    const full = request.query.full === '1' || request.query.full === 'true';
    syncUsage(getDb(), { full, force: true })
      .then((result) => response.json({ result, ...payload() }))
      .catch((error: unknown) => sendError(response, error));
  });

  return router;
}
