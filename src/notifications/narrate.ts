import { getConfig } from '../config.js';
import type { MrrAttribution, MrrCause } from './mrrMovement.js';

/**
 * One or two plain sentences on why MRR moved, written by a small model from
 * the attribution and nothing else.
 *
 * The model does not investigate anything. `attributeMrrChange` already named
 * every shop, amount, and cause from the stored records; the model only turns
 * that into prose. Its reply is then checked against the same facts, and a
 * reply that brings in an amount, count, shop, or cause the facts do not
 * contain is dropped. The report still carries the factual breakdown either
 * way, so a missing key, an outage, or a rejected reply costs only the sentence.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_ITEMS = 25;
const MAX_LENGTH = 500;

const SYSTEM_PROMPT = `You write the one-line "why" under the MRR figure in a Slack daily report for a Shopify app business.

Rules:
- Use only the JSON facts you are given. Never add a reason, store, plan, amount, date or count that is not in them.
- Copy every money amount exactly as it appears in the facts, with its sign removed and a $ in front. Never round, add or subtract amounts yourself; when you need a total, use a "total" value from "groups".
- Write counts as digits and take them from the "count" values in "groups". Never use number words such as "one" or "two", not even as pronouns; name the shop instead.
- Refer to a store by its "shop" value, copied exactly. Never write a myshopify.com address.
- Use the evidence strings to say what happened (for example frozen by Shopify, uninstalled, canceled, new paid subscription, no payment ever settled). Do not speculate beyond them. A "store_closed" cause means the merchant's store was closed or paused, not that they canceled.
- Items with "correction_to_yesterday": true are not new events: Shopify data that arrived after yesterday's report changed yesterday's figure. Say so separately.
- 1 or 2 sentences, under 300 characters, plain text, no bullet points, no markdown.`;

export interface NarrateOptions {
  apiKey?: string | null;
  model?: string;
  endpoint?: string;
}

/** The facts the model sees, and the validator checks against. */
export function narrationFacts(attribution: MrrAttribution, currency: string | null) {
  const groups = new Map<string, { cause: MrrCause; correction_to_yesterday: boolean; count: number; total: number }>();
  for (const item of attribution.items) {
    const key = `${item.restated} ${item.cause}`;
    const group = groups.get(key) ?? {
      cause: item.cause,
      correction_to_yesterday: item.restated,
      count: 0,
      total: 0,
    };
    group.count += 1;
    group.total = Math.round((group.total + item.delta) * 100) / 100;
    groups.set(key, group);
  }

  return {
    currency,
    mrr_yesterday: attribution.previous,
    yesterday_is: attribution.baseline === 'posted' ? 'the figure posted yesterday' : 'yesterday recomputed from today\'s data',
    mrr_today: attribution.current,
    change: attribution.change,
    unexplained: attribution.unexplained,
    groups: [...groups.values()],
    shops: attribution.items.slice(0, MAX_ITEMS).map((item) => ({
      shop: item.shop,
      app: item.app,
      plan: item.plan,
      change: item.delta,
      cause: item.cause,
      correction_to_yesterday: item.restated,
      never_paid: item.neverPaid,
      evidence: item.evidence,
    })),
  };
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** `1,234.5` → 1234.5, so "$1,234.50" in prose and 1234.5 in JSON compare equal. */
function numbersIn(text: string): number[] {
  return (text.replace(/(\d),(?=\d{3}\b)/g, '$1').match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/**
 * Claims a sentence can make, and what in the facts has to back each one.
 * Order matters only for `unfroz`, which is stripped before `froz` is tested.
 */
const CLAIMS: Array<{ pattern: RegExp; backed: (facts: ReturnType<typeof narrationFacts>) => boolean }> = [
  { pattern: /unfroz/i, backed: (f) => f.groups.some((g) => g.cause === 'unfrozen') },
  { pattern: /froz|freez/i, backed: (f) => f.groups.some((g) => g.cause === 'frozen') },
  { pattern: /uninstall/i, backed: (f) => f.groups.some((g) => g.cause === 'uninstalled') },
  { pattern: /cancel/i, backed: (f) => f.groups.some((g) => g.cause === 'canceled') },
  {
    pattern: /closed|clos(e|ing) (their|the|its) store|deactivat|paused/i,
    backed: (f) =>
      f.groups.some((g) => g.cause === 'store_closed') ||
      f.shops.some((s) => s.evidence.some((e) => e.includes('deactivated'))),
  },
  {
    pattern: /upgrad|downgrad|plan change|changed plan|switched/i,
    backed: (f) => f.groups.some((g) => g.cause === 'plan_change'),
  },
  {
    pattern: /new (paid|paying|subscri|customer)|convert/i,
    backed: (f) => f.groups.some((g) => g.cause === 'new_paid'),
  },
  {
    pattern: /never (paid|collected|settled|charged)|not (been )?(collected|settled)|did(n't| not) pay|before (they|it) could pay|unpaid/i,
    backed: (f) => f.shops.some((s) => s.never_paid),
  },
  { pattern: /usage/i, backed: (f) => f.groups.some((g) => g.cause === 'usage') },
  {
    pattern: /backdat|correct|restat|revis|late data|arrived late|after (yesterday's|the) report/i,
    backed: (f) => f.groups.some((g) => g.correction_to_yesterday),
  },
  { pattern: /refund|chargeback|dispute|discount|coupon|price (increase|rise|drop|cut)/i, backed: () => false },
];

/** Why `text` cannot be trusted against `facts`, or null when every claim in it is backed. */
export function rejectNarration(text: string, facts: ReturnType<typeof narrationFacts>): string | null {
  if (text.length === 0) return 'empty reply';
  if (text.length > MAX_LENGTH) return `reply is ${text.length} characters`;

  const shops = new Set(facts.shops.map((shop) => shop.shop.toLowerCase()));
  for (const domain of text.toLowerCase().match(/[a-z0-9][a-z0-9-]*\.myshopify\.com/g) ?? []) {
    if (!shops.has(domain)) return `the shop ${domain} is not in the facts`;
  }

  // A store's name is not a claim: "Cancel Club 7" must not read as a cancellation or a 7.
  let claims = text;
  for (const name of [...new Set(facts.shops.map((shop) => shop.shop))].sort((a, b) => b.length - a.length)) {
    claims = claims.split(name).join(' ');
  }

  const allowed = numbersIn(
    JSON.stringify({ ...facts, shops: facts.shops.map((shop) => ({ ...shop, shop: '' })) }),
  );
  for (const value of numbersIn(claims)) {
    if (!allowed.some((known) => Math.abs(known - value) < 0.005)) {
      return `the number ${value} is not in the facts`;
    }
  }
  for (const word of claims.toLowerCase().match(/\b[a-z]+\b/g) ?? []) {
    const value = NUMBER_WORDS[word];
    if (value !== undefined && !allowed.includes(value)) {
      return `"${word}" is not a count in the facts`;
    }
  }

  let rest = claims;
  for (const claim of CLAIMS) {
    if (claim.pattern.test(rest) && !claim.backed(facts)) {
      return `"${rest.match(claim.pattern)![0]}" is not backed by the facts`;
    }
    rest = rest.replace(new RegExp(claim.pattern.source, 'gi'), ' ');
  }
  return null;
}

/**
 * The model's sentence, or null when there is no key, the call fails, or the
 * reply does not hold up against the facts.
 */
export async function narrateMrrChange(
  attribution: MrrAttribution,
  currency: string | null,
  options: NarrateOptions = {},
): Promise<string | null> {
  const config = getConfig().openRouter;
  const apiKey = options.apiKey === undefined ? config.apiKey : options.apiKey;
  if (!apiKey || attribution.items.length === 0) return null;

  const facts = narrationFacts(attribution, currency);
  try {
    const response = await fetch(options.endpoint ?? ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'PartnerDex daily report',
      },
      body: JSON.stringify({
        model: options.model ?? config.model,
        temperature: 0,
        max_tokens: 1000,
        // Rephrasing needs no reasoning, and a reasoning model left to think
        // can spend the whole token budget before writing a word.
        reasoning: { enabled: false },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(facts) },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.warn(`[partnerdex] MRR narration failed: HTTP ${response.status}`);
      return null;
    }
    const body = (await response.json()) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }>;
    };
    const choice = body.choices?.[0];
    const text = (choice?.message?.content ?? '').trim().replace(/\s+/g, ' ');
    const rejected = rejectNarration(text, facts);
    if (rejected) {
      console.warn(
        `[partnerdex] MRR narration discarded: ${rejected} (finish: ${choice?.finish_reason ?? 'none'}). Reply was: ${text}`,
      );
      return null;
    }
    return text;
  } catch (cause) {
    console.warn('[partnerdex] MRR narration failed:', cause);
    return null;
  }
}
