import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { getDb } from '../src/db/index.js';
import { isExcluded, saveConnection, saveSettings } from '../src/mixpanel/connection.js';
import { replaceUsage, syncUsage, useMixpanelFetch } from '../src/mixpanel/ingest.js';
import { multipliersReport } from '../src/multipliers/index.js';
import { createApp } from '../src/server/index.js';
import { resetEnvironment, seed, seedOneTimeCharges } from './helpers.js';

/**
 * The Multipliers page, at the places it could quietly mislead:
 *
 *   - revenue taken at list price when the shop actually pays less
 *   - one-time credit packs ignored, or counted outside the usage window
 *   - free installs that cost money left off the curve, which hides the tail
 *   - an internal store counted as a customer
 *   - a re-negotiated custom charge counted as one churn and one new customer
 *   - usage attributed to the wrong shop, or a re-read doubling a day
 *   - the service account secret leaking back out of the settings API
 */

const NOW = new Date();
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const day = (days: number) => ago(days).slice(0, 10);

function usage(rows: Record<string, number>, daysAgo = 5): void {
  const counts = new Map(Object.entries(rows).map(([domain, n]) => [`${domain}|${day(daysAgo)}`, n]));
  replaceUsage(getDb(), day(daysAgo), day(daysAgo), counts);
}

describe('multipliers: the profit whale', () => {
  beforeEach(() => {
    resetEnvironment();
    seed(
      [
        // Lists at 100, last paid 50: a discount the page must price at 50.
        { chargeRef: 'a', shopId: '1', amount: 100, activatedAt: ago(90), firstSaleAt: ago(90), extraSales: [{ at: ago(10), gross: 50 }] },
        { chargeRef: 'b', shopId: '2', amount: 20, activatedAt: ago(60), firstSaleAt: ago(60) },
        { chargeRef: 'd', shopId: '4', amount: 30, activatedAt: ago(40), firstSaleAt: ago(40) },
        // Internal store: paying, heavy usage, and excluded by pattern.
        { chargeRef: 'e', shopId: '5', amount: 500, activatedAt: ago(40), firstSaleAt: ago(40) },
      ],
      { installs: [{ shopId: '3', at: ago(20) }] },
    );
    // B buys a $20 credit pack inside the window; one bought 40 days ago is not
    // this window's money.
    seedOneTimeCharges([
      { id: 'pack-1', shopId: '2', amount: 20, at: ago(3) },
      { id: 'pack-old', shopId: '2', amount: 99, at: ago(40) },
    ]);
    saveSettings({ costPerGeneration: 0.045, costPerPayingShop: 2, excludedDomains: 's5.*' });
    usage({ 's1.example': 200, 's2.example': 1000, 's3.example': 100, 's5.example': 9000 });
  });

  it('prices shops at what they pay plus credits, includes free installs that cost money, and finds the crest', () => {
    const report = multipliersReport({ now: NOW });
    const byShop = new Map(report.customers.map((row) => [row.domain, row]));

    // A: 50 - (200 × 0.045 + 2) = 39. D: 30 - 2 = 28. C (free): -4.5.
    // B: 20 + 20 credits - (1000 × 0.045 + 2) = -7.
    assert.deepEqual(
      report.customers.map((row) => [row.domain, row.profit]),
      [
        ['s1.example', 39],
        ['s4.example', 28],
        ['s3.example', -4.5],
        ['s2.example', -7],
      ],
    );
    assert.equal(byShop.get('s2.example')!.credits, 20);
    assert.equal(byShop.get('s2.example')!.paidMrr, 20, 'credits are not MRR');
    assert.equal(byShop.get('s1.example')!.paidMrr, 50);
    assert.equal(byShop.get('s1.example')!.discounted, true);
    assert.equal(byShop.get('s3.example')!.status, 'free');

    assert.equal(report.whale.peakProfit, 67);
    assert.equal(report.whale.peakRank, 2);
    assert.equal(report.whale.finalProfit, 55.5);
    assert.equal(report.whale.whaleRatio, 1.207);
    assert.deepEqual(report.whale.takers, { count: 2, profit: -11.5 });
    assert.equal(report.whale.credits, 20);
    assert.equal(report.excluded, 1);
    assert.equal(report.usage.generations, 1300, 'excluded usage is not counted');
  });
});

describe('multipliers: the ceiling by tier', () => {
  beforeEach(() => {
    resetEnvironment();
    seed([
      // An upgrade across tiers: Trend loses one, Runway gains one.
      { chargeRef: 't1', shopId: '1', planName: 'Trend', amount: 20, activatedAt: ago(100), firstSaleAt: ago(100), churnedAt: ago(50) },
      { chargeRef: 'r1', shopId: '1', planName: 'Runway', amount: 50, activatedAt: ago(50), firstSaleAt: ago(50) },
      // A negotiated charge replaced by another negotiated charge: no movement.
      { chargeRef: 'c1', shopId: '2', planName: 'Custom-1-6e8c3a8e-1b0a-4a51-9a63-1f7f3c1e0c11', amount: 300, activatedAt: ago(120), firstSaleAt: ago(120), churnedAt: ago(40) },
      { chargeRef: 'c2', shopId: '2', planName: 'Custom-2-0b6a4d2e-77c4-4a3e-8d0f-2c6e5b9a1d22', amount: 400, activatedAt: ago(40), firstSaleAt: ago(40) },
    ]);
  });

  it('counts moves between tiers and ignores re-pricing inside one', () => {
    const tiers = new Map(multipliersReport({ now: NOW }).ceiling.tiers.map((tier) => [tier.key, tier]));

    assert.equal(tiers.get('Trend')!.lostPerMonth, 0.2, 'the upgrade leaves Trend');
    assert.equal(tiers.get('Runway')!.newPerMonth, 0.2, 'and joins Runway');
    const custom = tiers.get('Custom & negotiated')!;
    assert.equal(custom.current, 1);
    assert.equal(custom.newPerMonth, 0.2, 'only the original signup is new');
    assert.equal(custom.lostPerMonth, 0, 'the replacement is not a churn');
    assert.equal(custom.ceiling, null, 'no churn, no finite ceiling');
  });
});

describe('multipliers: Mixpanel usage', () => {
  let requests: Array<{ url: string; auth: string | null }> = [];

  beforeEach(() => {
    resetEnvironment();
    requests = [];
    saveConnection({ projectId: '42', region: 'EU', username: 'sa.user', secret: 'shh-secret' });
    saveSettings({ generationEvents: ['Gemini generation', 'FLUX Pro generation'] });

    const at = (days: number) => Math.floor((NOW.getTime() - days * DAY) / 1000);
    const lines = [
      { event: 'Gemini generation', properties: { distinct_id: 'Club21-[950]', time: at(1), $insert_id: 'g-1' } },
      // A retried copy: the raw export keeps it, Mixpanel's reports drop it.
      { event: 'Gemini generation', properties: { distinct_id: 'Club21-[950]', time: at(1), $insert_id: 'g-1' } },
      { event: 'FLUX Pro generation', properties: { distinct_id: 'Club21-[950]', time: at(1), $insert_id: 'f-1' } },
      // No profile, but the distinct id is itself a shop domain.
      { event: 'Gemini generation', properties: { distinct_id: 'Direct.myshopify.com', time: at(2) } },
      // No profile and no domain: counted, but against nobody.
      { event: 'Gemini generation', properties: { distinct_id: 'mystery', time: at(2) } },
      // Not a generation event.
      { event: 'Customer try-on', properties: { distinct_id: 'Club21-[950]', time: at(1) } },
    ];

    useMixpanelFetch((async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (url.includes('/api/query/engage')) {
        return Response.json({
          page: 0,
          page_size: 1000,
          session_id: 's',
          results: [
            { $distinct_id: 'Club21-[950]', $properties: { domain: 'club21.myshopify.com' } },
            { $distinct_id: 'Named-[1]', $properties: { $name: 'named.myshopify.com' } },
          ],
        });
      }
      return new Response(lines.map((line) => JSON.stringify(line)).join('\n'));
    }) as typeof fetch);
  });

  afterEach(() => useMixpanelFetch(null));

  it('attributes generations to shops by profile domain, drops retried duplicates, and replaces the days it re-reads', async () => {
    // A stale row inside the re-read window must be replaced, not added to.
    replaceUsage(getDb(), day(1), day(1), new Map([[`club21.myshopify.com|${day(1)}`, 99]]));

    const result = await syncUsage(getDb(), { now: NOW });
    assert.equal(result.generations, 4);
    assert.equal(result.unattributed, 1);

    const rows = getDb()
      .prepare('SELECT domain, day, generations FROM shop_usage_daily ORDER BY domain')
      .all();
    assert.deepEqual(rows, [
      { domain: 'club21.myshopify.com', day: day(1), generations: 2 },
      { domain: 'direct.myshopify.com', day: day(2), generations: 1 },
    ]);

    assert.ok(requests.every((request) => request.auth === `Basic ${Buffer.from('sa.user:shh-secret').toString('base64')}`));
    assert.ok(requests.some((request) => request.url.startsWith('https://data-eu.mixpanel.com/api/2.0/export')));
  });

  it('stops calling Mixpanel once it says 429, and throttles failed syncs like working ones', async () => {
    let calls = 0;
    useMixpanelFetch((async () => {
      calls += 1;
      return new Response('{"error":"rate limit exceeded"}', { status: 429 });
    }) as typeof fetch);

    await assert.rejects(syncUsage(getDb(), { now: NOW, force: true }), /rate limiting/);
    const afterFirst = calls;

    // The background loop ticks every few minutes; none of these may reach Mixpanel.
    for (const minutes of [5, 10, 30]) {
      const later = new Date(NOW.getTime() + minutes * 60_000);
      assert.match((await syncUsage(getDb(), { now: later })).skipped ?? '', /Rate limited/);
    }
    // Nor may a manual "Sync now" before the wait is over.
    await assert.rejects(syncUsage(getDb(), { now: new Date(NOW.getTime() + 20 * 60_000), force: true }), /Waiting until/);
    assert.equal(calls, afterFirst);

    // After the hour, one failing background attempt is made, then it is throttled again.
    useMixpanelFetch((async () => {
      calls += 1;
      return new Response('nope', { status: 500 });
    }) as typeof fetch);
    const hourLater = new Date(NOW.getTime() + 61 * 60_000);
    await assert.rejects(syncUsage(getDb(), { now: hourLater }));
    const afterRetry = calls;
    const tick = new Date(hourLater.getTime() + 5 * 60_000);
    assert.match((await syncUsage(getDb(), { now: tick })).skipped ?? '', /less than an hour/);
    assert.equal(calls, afterRetry);
  });

  it('never hands the secret back', async () => {
    const server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const body = await (await fetch(`http://127.0.0.1:${port}/api/mixpanel`)).text();
      assert.ok(body.includes('sa.user'));
      assert.ok(!body.includes('shh-secret'));
    } finally {
      server.close();
    }
  });
});

describe('multipliers: excluded stores', () => {
  it('matches handles, full domains and wildcards', () => {
    const patterns = ['antla-*', 'womensuits-dev', 'exact.myshopify.com'];
    assert.equal(isExcluded('antla-staging.myshopify.com', patterns), true);
    assert.equal(isExcluded('womensuits-dev.myshopify.com', patterns), true);
    assert.equal(isExcluded('exact.myshopify.com', patterns), true);
    assert.equal(isExcluded('notantla-x.myshopify.com', patterns), false);
    assert.equal(isExcluded('womensuits-dev-2.myshopify.com', patterns), false);
  });
});
