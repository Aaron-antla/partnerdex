export type MetricFormat = 'money' | 'percent' | 'count' | 'number';

export interface TimeSeriesPoint {
  value: number;
  change: number | null;
  periodStart: string;
  periodEnd: string;
  provisional?: boolean;
}

export interface NamedSeries {
  key: string;
  name: string;
  data: Array<{ date: string; value: number }>;
}

/** The same metric over the equal-length span immediately before this one. */
export interface MetricComparison {
  previousValue: number;
  change: number;
  /** Null when the previous period was zero — no finite percentage exists. */
  changePercent: number | null;
  periodStart: string;
  periodEnd: string;
}

export interface MetricResponse {
  metric: string;
  value: number;
  format: MetricFormat;
  currency: string | null;
  period: string;
  periodStart: string;
  periodEnd: string;
  timeSeriesInterval: string;
  timeSeries: TimeSeriesPoint[];
  series?: NamedSeries[];
  comparison?: MetricComparison;
  meta?: Record<string, unknown>;
}

export type Overview = Record<string, MetricResponse>;

export interface AppSummary {
  id: string;
  name: string;
}

/** The background sync loop's own account of itself. */
export interface SyncStatus {
  enabled: boolean;
  intervalMinutes: number;
  running: boolean;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextRunAt: string | null;
}

export interface Status {
  apps: number;
  shops: number;
  events: number;
  transactions: number;
  subscriptions: number;
  customerEvents: number;
  lastSyncAt: string | null;
  sync: SyncStatus;
}

export interface QueryState {
  period: string;
  appId: string;
  includeUsage: boolean;
  includeTrials: boolean;
}

/**
 * Note the absence of `interval`. Granularity is not a filter any more: the
 * server's one range-to-interval ladder decides it, so a reader cannot put the
 * axis into a state that disagrees with the figures beside it.
 */
export function toSearchParams(query: QueryState): URLSearchParams {
  const params = new URLSearchParams({
    period: query.period,
    includeUsage: String(query.includeUsage),
    includeTrials: String(query.includeTrials),
  });
  // No `end` either: the dashboard always reads as of now. The server still
  // honours the parameter, so an as-of reconstruction stays available to
  // anything calling the API directly.
  if (query.appId) params.set('appIds', query.appId);
  return params;
}

/**
 * Fired when the server says a request was not authenticated, so the shell can
 * fall back to the login form from wherever the reader happened to be. A
 * session expires on its own clock, which means any request can be the one that
 * discovers it — polling status at 3am included.
 */
export const SIGNED_OUT_EVENT = 'partnerdex:signed-out';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  // The login endpoint answers 401 for a wrong password; that is an answer to a
  // question the reader just asked, not a session that lapsed underneath them.
  if (response.status === 401 && !url.startsWith('/api/auth/')) {
    window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  }
  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body; keep the status message.
    }
    throw new Error(message);
  }
  // 204 on delete: there is no body to parse.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const getJson = <T,>(url: string): Promise<T> => request<T>(url);

const sendJson = <T,>(method: string, url: string, body?: unknown): Promise<T> =>
  request<T>(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/**
 * One request per page. Each metric costs the server two reconstructions — its
 * own window and the previous one — so a page asks only for the cards it shows.
 */
export const fetchOverview = (query: QueryState, metrics: string[]): Promise<Overview> => {
  const params = toSearchParams(query);
  params.set('metrics', metrics.join(','));
  return getJson<Overview>(`/api/overview?${params.toString()}`);
};

export const fetchApps = (): Promise<{ apps: AppSummary[] }> =>
  getJson<{ apps: AppSummary[] }>('/api/apps');

export const fetchStatus = (): Promise<Status> => getJson<Status>('/api/status');

/* ------------------------------------------------------------------ auth */

export interface Session {
  /** False when no DASHBOARD_PASSWORD is set — the dashboard is open. */
  required: boolean;
  authenticated: boolean;
}

export const fetchSession = (): Promise<Session> => getJson<Session>('/api/auth/session');

export const login = (password: string, remember: boolean): Promise<{ ok: boolean }> =>
  sendJson<{ ok: boolean }>('POST', '/api/auth/login', { password, remember });

export const logout = (): Promise<{ ok: boolean }> =>
  sendJson<{ ok: boolean }>('POST', '/api/auth/logout');

/* ------------------------------------------------------------- customers */

export type CustomerStatus = 'paying' | 'trialing' | 'installed' | 'churned' | 'gone';

export interface CustomerSummary {
  shopId: string;
  name: string | null;
  domain: string | null;
  status: CustomerStatus;
  mrr: number;
  currency: string | null;
  activeSubscriptions: number;
  activeInstalls: number;
  lifetimeGross: number;
  lifetimeNet: number;
  firstSeenAt: string | null;
  lastEventAt: string | null;
}

export interface CustomerListResult {
  customers: CustomerSummary[];
  total: number;
  limit: number;
  offset: number;
  query: string;
}

export interface CustomerSubscription {
  chargeId: string;
  appId: string;
  appName: string | null;
  planName: string | null;
  amount: number;
  monthlyAmount: number;
  currency: string | null;
  billingInterval: string;
  status: 'active' | 'trialing' | 'frozen' | 'churned' | 'replaced' | 'pending';
  activatedAt: string | null;
  conversionAt: string | null;
  churnAt: string | null;
  churnReason: string | null;
  trialStatus: string;
  trialEndsAt: string | null;
  paidSaleCount: number;
  lastSaleAt: string | null;
}

export interface CustomerEventRecord {
  eventId: string;
  type: string;
  occurredAt: string;
  appId: string;
  appName: string | null;
  chargeId: string;
  planName: string | null;
  planAmount: number | null;
  billingInterval: string | null;
  currency: string | null;
  netChange: number | null;
  amount: number | null;
  detail: Record<string, unknown> | null;
}

export interface CustomerDetail {
  shopId: string;
  name: string | null;
  domain: string | null;
  status: CustomerStatus;
  mrr: number;
  currency: string | null;
  lifetimeGross: number;
  lifetimeNet: number;
  paymentCount: number;
  firstSeenAt: string | null;
  lastEventAt: string | null;
  subscriptions: CustomerSubscription[];
  events: CustomerEventRecord[];
  apps: Array<{ appId: string; appName: string | null; installedAt: string | null }>;
}

export const fetchCustomers = (options: {
  search?: string;
  sort?: string;
  limit?: number;
  offset?: number;
  appId?: string;
}): Promise<CustomerListResult> => {
  const params = new URLSearchParams();
  if (options.search) params.set('q', options.search);
  if (options.sort) params.set('sort', options.sort);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));
  if (options.appId) params.set('appIds', options.appId);
  return getJson<CustomerListResult>(`/api/customers?${params.toString()}`);
};

export const fetchCustomer = (shopId: string, appId = ''): Promise<CustomerDetail> => {
  const params = new URLSearchParams();
  if (appId) params.set('appIds', appId);
  const query = params.toString();
  return getJson<CustomerDetail>(
    `/api/customers/${encodeURIComponent(shopId)}${query ? `?${query}` : ''}`,
  );
};

/* --------------------------------------------------------- notifications */

export interface NotificationTopic {
  key: string;
  label: string;
  description: string;
  eventTypes: string[];
  /** What the toggle promises, in the reader's words. */
  covers: string[];
}

/**
 * Note the absence of a webhook URL. It goes to the server once and is never
 * sent back, so a channel is identified here by its name and a masked hint.
 */
export interface NotificationChannel {
  id: string;
  name: string;
  webhookHint: string;
  createdAt: string;
  lastDeliveryAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  topics: string[];
}

export interface NotificationSettings {
  topics: NotificationTopic[];
  channels: NotificationChannel[];
}

const CHANNELS = '/api/notifications/channels';

export const fetchNotifications = (): Promise<NotificationSettings> =>
  getJson<NotificationSettings>('/api/notifications');

export const createChannel = (input: {
  name: string;
  webhookUrl: string;
}): Promise<NotificationChannel> => sendJson<NotificationChannel>('POST', CHANNELS, input);

export const updateChannel = (
  id: string,
  patch: { name?: string; webhookUrl?: string },
): Promise<NotificationChannel> =>
  sendJson<NotificationChannel>('PATCH', `${CHANNELS}/${encodeURIComponent(id)}`, patch);

export const deleteChannel = (id: string): Promise<void> =>
  sendJson<void>('DELETE', `${CHANNELS}/${encodeURIComponent(id)}`);

export const setChannelTopic = (
  id: string,
  topic: string,
  enabled: boolean,
): Promise<NotificationChannel> =>
  sendJson<NotificationChannel>(
    'PUT',
    `${CHANNELS}/${encodeURIComponent(id)}/topics/${encodeURIComponent(topic)}`,
    { enabled },
  );

export const testChannel = (
  id: string,
): Promise<{ ok: boolean; error: string | null; channel: NotificationChannel }> =>
  sendJson('POST', `${CHANNELS}/${encodeURIComponent(id)}/test`);
