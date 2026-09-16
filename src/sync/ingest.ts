import type { Db } from '../db/index.js';
import { toUtcIso } from '../metrics/time.js';

/** `gid://partners/App/1234` -> `1234`. Bare ids pass through unchanged. */
export function gidTail(gid: string | null | undefined): string {
  if (!gid) return '';
  return gid.split('/').pop() ?? '';
}

export interface MoneyNode {
  amount: string | number | null;
  currencyCode: string | null;
}

export function money(node: MoneyNode | null | undefined): { amount: number; currency: string } {
  if (!node) return { amount: 0, currency: '' };
  const amount = Number(node.amount ?? 0);
  return {
    amount: Number.isFinite(amount) ? amount : 0,
    currency: node.currencyCode ?? '',
  };
}

export interface ShopNode {
  id: string;
  name: string | null;
  myshopifyDomain: string | null;
}

export interface AppNode {
  id: string;
  name: string;
  apiKey?: string | null;
}

export interface TransactionNode {
  id: string;
  createdAt: string;
  __typename: string;
  app?: AppNode | null;
  shop?: ShopNode | null;
  chargeId?: string | null;
  billingInterval?: string | null;
  grossAmount?: MoneyNode | null;
  netAmount?: MoneyNode | null;
  shopifyFee?: MoneyNode | null;
}

export interface UninstallFeedback {
  reason: string | null;
  description: string | null;
}

export interface AppEventNode {
  type: string;
  occurredAt: string;
  __typename: string;
  shop?: ShopNode | null;
  charge?: {
    id: string;
    name: string | null;
    test: boolean;
    billingOn: string | null;
    amount: MoneyNode | null;
  } | null;
  reason?: string | null;
  description?: string | null;
}

/** Empty, missing, or non-string GraphQL values are stored as null. */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function uninstallFeedback(node: AppEventNode): UninstallFeedback {
  if (node.type !== 'RELATIONSHIP_UNINSTALLED') {
    return { reason: null, description: null };
  }
  return {
    reason: optionalText(node.reason),
    description: optionalText(node.description),
  };
}

export function upsertApp(db: Db, app: AppNode): string {
  const id = gidTail(app.id);
  if (!id) return '';
  db.prepare(
    `INSERT INTO apps (id, name, api_key, discovered_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       api_key = COALESCE(excluded.api_key, apps.api_key)`,
  ).run(id, app.name, app.apiKey ?? null, new Date().toISOString());
  return id;
}

export function upsertShop(db: Db, shop: ShopNode | null | undefined): string {
  const id = gidTail(shop?.id);
  if (!id || !shop) return '';
  db.prepare(
    `INSERT INTO shops (id, name, myshopify_domain)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = COALESCE(excluded.name, shops.name),
       myshopify_domain = COALESCE(excluded.myshopify_domain, shops.myshopify_domain)`,
  ).run(id, shop.name ?? null, shop.myshopifyDomain ?? null);
  return id;
}

export function insertTransactions(db: Db, nodes: TransactionNode[]): number {
  const statement = db.prepare(
    `INSERT INTO transactions (
       id, type, app_id, shop_id, charge_id, charge_ref, created_at,
       billing_interval, gross_amount, net_amount, shopify_fee, currency
     ) VALUES (
       @id, @type, @appId, @shopId, @chargeId, @chargeRef, @createdAt,
       @billingInterval, @grossAmount, @netAmount, @shopifyFee, @currency
     )
     ON CONFLICT(id) DO UPDATE SET
       gross_amount = excluded.gross_amount,
       net_amount = excluded.net_amount,
       shopify_fee = excluded.shopify_fee,
       billing_interval = COALESCE(excluded.billing_interval, transactions.billing_interval)`,
  );

  const run = db.transaction((batch: TransactionNode[]) => {
    let written = 0;
    for (const node of batch) {
      if (!node.app) continue; // non-app transactions (tax, referral) are out of scope
      const appId = upsertApp(db, node.app);
      const shopId = upsertShop(db, node.shop);
      const gross = money(node.grossAmount);
      const net = money(node.netAmount);
      const fee = money(node.shopifyFee);

      statement.run({
        id: node.id,
        type: node.__typename,
        appId,
        shopId,
        chargeId: node.chargeId ?? '',
        chargeRef: gidTail(node.chargeId),
        createdAt: toUtcIso(node.createdAt),
        billingInterval: node.billingInterval ?? null,
        grossAmount: gross.amount,
        netAmount: net.amount,
        shopifyFee: fee.amount,
        currency: gross.currency || net.currency || fee.currency,
      });
      written += 1;
    }
    return written;
  });

  return run(nodes);
}

export function insertAppEvents(db: Db, appId: string, nodes: AppEventNode[]): number {
  const statement = db.prepare(
    `INSERT INTO app_events (
       app_id, shop_id, type, occurred_at, charge_id, charge_name,
       charge_amount, charge_currency, charge_test, billing_on,
       uninstall_reason, uninstall_description
     ) VALUES (
       @appId, @shopId, @type, @occurredAt, @chargeId, @chargeName,
       @chargeAmount, @chargeCurrency, @chargeTest, @billingOn,
       @uninstallReason, @uninstallDescription
     )
     ON CONFLICT(app_id, type, occurred_at, charge_id, shop_id) DO UPDATE SET
       charge_name = COALESCE(excluded.charge_name, app_events.charge_name),
       charge_amount = COALESCE(excluded.charge_amount, app_events.charge_amount),
       billing_on = COALESCE(excluded.billing_on, app_events.billing_on),
       uninstall_reason = COALESCE(excluded.uninstall_reason, app_events.uninstall_reason),
       uninstall_description = COALESCE(excluded.uninstall_description, app_events.uninstall_description)`,
  );

  const run = db.transaction((batch: AppEventNode[]) => {
    let written = 0;
    for (const node of batch) {
      const shopId = upsertShop(db, node.shop);
      const charge = node.charge;
      const amount = money(charge?.amount);
      const survey = uninstallFeedback(node);

      statement.run({
        appId,
        shopId,
        type: node.type,
        occurredAt: toUtcIso(node.occurredAt),
        chargeId: charge?.id ?? '',
        chargeName: charge?.name ?? null,
        chargeAmount: charge ? amount.amount : null,
        chargeCurrency: charge ? amount.currency : null,
        chargeTest: charge?.test ? 1 : 0,
        billingOn: charge?.billingOn ? toUtcIso(charge.billingOn) : null,
        uninstallReason: survey.reason,
        uninstallDescription: survey.description,
      });
      written += 1;
    }
    return written;
  });

  return run(nodes);
}
