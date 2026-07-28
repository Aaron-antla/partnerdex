import { useEffect, useState } from 'react';
import {
  fetchCustomer,
  type CustomerDetail as Detail,
  type CustomerEventRecord,
  type CustomerSubscription,
} from '../api';
import { formatFullDate, formatValue } from '../format';
import { StatusPill } from './Customers';

/**
 * One merchant, end to end: what they run today, what they have paid, and
 * everything that has ever happened to them.
 *
 * The timeline is the compiled lifecycle, not the raw feed — so an upgrade
 * reads as one upgrade rather than as a cancellation followed by a signup, and
 * the churn shown here is the same churn the reports count.
 */

const EVENT_LABEL: Record<string, string> = {
  installed: 'Installed',
  reinstalled: 'Reinstalled',
  uninstalled: 'Uninstalled',
  deactivated: 'Store deactivated',
  reactivated: 'Store reactivated',
  subscribed: 'Subscribed',
  resubscribed: 'Resubscribed',
  upgraded: 'Upgraded',
  downgraded: 'Downgraded',
  unsubscribed: 'Cancelled',
  subscription_frozen: 'Billing frozen',
  subscription_unfrozen: 'Billing resumed',
  charge_abandoned: 'Charge abandoned',
  trial_started: 'Trial started',
  trial_converted: 'Trial converted',
  trial_expired: 'Trial ended',
  payment: 'Payment',
  refund: 'Refund',
};

/** Groups the vocabulary into the three things a reader is scanning for. */
const EVENT_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  installed: 'good',
  reinstalled: 'good',
  subscribed: 'good',
  resubscribed: 'good',
  upgraded: 'good',
  trial_converted: 'good',
  subscription_unfrozen: 'good',
  reactivated: 'good',
  payment: 'good',
  uninstalled: 'bad',
  unsubscribed: 'bad',
  downgraded: 'bad',
  subscription_frozen: 'bad',
  trial_expired: 'bad',
  charge_abandoned: 'bad',
  deactivated: 'bad',
  refund: 'bad',
};

const SUB_STATUS_LABEL: Record<CustomerSubscription['status'], string> = {
  active: 'Active',
  trialing: 'On trial',
  frozen: 'Frozen',
  churned: 'Cancelled',
  replaced: 'Replaced',
  pending: 'Not yet billing',
};

function cadence(interval: string): string {
  return interval === 'ANNUAL' ? 'per year' : 'per 30 days';
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string | null;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

function EventRow({ event, currency }: { event: CustomerEventRecord; currency: string | null }) {
  const tone = EVENT_TONE[event.type] ?? 'neutral';
  const label = EVENT_LABEL[event.type] ?? event.type;

  // Each event says the one thing that matters about it: cash for a payment,
  // the plan for a subscription move, nothing at all for an install.
  let figure: string | null = null;
  if (event.amount !== null) {
    figure = formatValue(event.amount, 'money', event.currency ?? currency);
  } else if (event.netChange !== null && event.netChange !== 0) {
    const sign = event.netChange > 0 ? '+' : '−';
    figure = `${sign}${formatValue(Math.abs(event.netChange), 'money', event.currency ?? currency)} MRR`;
  }

  const detail = event.detail ?? {};
  const churnReason = typeof detail.churnReason === 'string' ? detail.churnReason : null;

  return (
    <li className={`event event-${tone}`}>
      <div className="event-marker" aria-hidden="true" />
      <div className="event-body">
        <div className="event-head">
          <span className="event-label">{label}</span>
          {figure ? <span className="event-figure">{figure}</span> : null}
        </div>
        <div className="event-meta">
          <span>{formatFullDate(event.occurredAt)}</span>
          {event.appName ? <span>{event.appName}</span> : null}
          {event.planName ? <span>{event.planName}</span> : null}
          {churnReason === 'uninstalled' ? <span>ended by uninstall</span> : null}
        </div>
      </div>
    </li>
  );
}

function SubscriptionTable({
  rows,
  currency,
  caption,
}: {
  rows: CustomerSubscription[];
  currency: string | null;
  caption: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="card full">
      <div className="card-head">
        <span className="card-label">{caption}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>App</th>
              <th>Plan</th>
              <th>Price</th>
              <th>MRR</th>
              <th>Status</th>
              <th>Since</th>
              <th>Payments</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.chargeId}>
                <td>{row.appName ?? row.appId}</td>
                <td>{row.planName ?? '—'}</td>
                <td>
                  {formatValue(row.amount, 'money', row.currency ?? currency)}
                  <span className="cadence"> {cadence(row.billingInterval)}</span>
                </td>
                <td>{formatValue(row.monthlyAmount, 'money', row.currency ?? currency)}</td>
                <td>
                  <span className={`pill pill-sub-${row.status}`}>
                    {SUB_STATUS_LABEL[row.status]}
                  </span>
                </td>
                <td>{row.activatedAt ? formatFullDate(row.activatedAt) : '—'}</td>
                <td>{row.paidSaleCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CustomerDetail({ shopId, appId }: { shopId: string; appId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    fetchCustomer(shopId, appId)
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        setError(null);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [shopId, appId]);

  if (loading) return <div className="skeleton">Loading merchant…</div>;

  if (error || !detail) {
    return (
      <div className="notice error">
        <h2>Could not load this merchant</h2>
        <p>{error ?? 'Not found.'}</p>
        <p>
          <a href="#/customers">Back to customers</a>
        </p>
      </div>
    );
  }

  const live = detail.subscriptions.filter(
    (sub) => sub.status === 'active' || sub.status === 'trialing' || sub.status === 'frozen',
  );
  const past = detail.subscriptions.filter((sub) => !live.includes(sub));
  const share = detail.lifetimeGross - detail.lifetimeNet;

  return (
    <>
      <div className="customer-head">
        <div>
          <a className="back-link" href="#/customers">
            ← All customers
          </a>
          <h2 className="customer-title">
            {detail.name ?? detail.domain ?? detail.shopId} <StatusPill status={detail.status} />
          </h2>
          {detail.domain ? (
            <a
              className="customer-domain-link"
              href={`https://${detail.domain}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              {detail.domain}
            </a>
          ) : null}
        </div>
      </div>

      <div className="stat-row">
        <Stat
          label="Current MRR"
          value={formatValue(detail.mrr, 'money', detail.currency)}
          note={`${live.filter((sub) => sub.status === 'active').length} paying subscription(s)`}
        />
        <Stat
          label="Paid to date"
          value={formatValue(detail.lifetimeGross, 'money', detail.currency)}
          note={`${detail.paymentCount} charge(s)`}
        />
        <Stat
          label="Net of revenue share"
          value={formatValue(detail.lifetimeNet, 'money', detail.currency)}
          note={`${formatValue(share, 'money', detail.currency)} to Shopify`}
        />
        <Stat
          label="Customer since"
          value={detail.firstSeenAt ? formatFullDate(detail.firstSeenAt) : '—'}
          note={detail.lastEventAt ? `Last seen ${formatFullDate(detail.lastEventAt)}` : null}
        />
      </div>

      <SubscriptionTable rows={live} currency={detail.currency} caption="Subscribed right now" />
      <SubscriptionTable rows={past} currency={detail.currency} caption="Past subscriptions" />

      <div className="card full">
        <div className="card-head">
          <span className="card-label">Timeline</span>
          <span className="card-subtitle">
            Compiled lifecycle, newest first. Plan changes appear as one move rather than as a
            cancellation and a signup.
          </span>
        </div>
        {detail.events.length === 0 ? (
          <p className="footnote">No events recorded for this merchant.</p>
        ) : (
          <ol className="timeline">
            {detail.events.map((event) => (
              <EventRow key={event.eventId} event={event} currency={detail.currency} />
            ))}
          </ol>
        )}
      </div>
    </>
  );
}
