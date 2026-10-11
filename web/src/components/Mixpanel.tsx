import { useEffect, useState } from 'react';
import {
  checkMixpanel,
  disconnectMixpanel,
  fetchMixpanel,
  saveMixpanel,
  saveMultiplierSettings,
  syncMixpanel,
  type MixpanelSettingsPayload,
} from '../api';
import { formatCalendarDate, formatDateTime } from '../format';

/**
 * Where usage comes from, and what it costs.
 *
 * Two cards because they change for different reasons: the service account is
 * set once and rotated, the cost model moves whenever a model price does. The
 * cost model works without the connection, so Multipliers can be read before
 * Mixpanel is wired up.
 */

function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      await work();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, note, setNote, run };
}

function Connection({
  payload,
  onChanged,
}: {
  payload: MixpanelSettingsPayload;
  onChanged: (next: MixpanelSettingsPayload) => void;
}) {
  const existing = payload.connection;
  const [projectId, setProjectId] = useState(existing?.projectId ?? '');
  const [region, setRegion] = useState<string>(existing?.region ?? 'US');
  const [username, setUsername] = useState(existing?.username ?? '');
  const [secret, setSecret] = useState('');
  const [confirming, setConfirming] = useState(false);
  const { busy, error, note, setNote, run } = useAction();

  const save = () =>
    run('save', async () => {
      onChanged(
        await saveMixpanel({ projectId, region, username, ...(secret.trim() ? { secret: secret.trim() } : {}) }),
      );
      setSecret('');
      setNote('Saved. Test the connection, then sync.');
    });

  const test = () =>
    run('test', async () => {
      const { check, ...next } = await checkMixpanel();
      onChanged(next);
      if (check.ok) setNote(`The account works. ${check.profiles} user profile(s) name a shop domain.`);
      else throw new Error(check.error ?? 'The connection could not be verified.');
    });

  const sync = () =>
    run('sync', async () => {
      const { result, ...next } = await syncMixpanel(!payload.stats.latest);
      onChanged(next);
      setNote(
        result.skipped ??
          `Pulled ${result.generations} generation(s) from ${result.from} to ${result.to}` +
            (result.unattributed > 0 ? `; ${result.unattributed} had no shop domain on their profile.` : '.'),
      );
    });

  const disconnect = () =>
    run('disconnect', async () => {
      await disconnectMixpanel();
      onChanged({ ...payload, connection: null });
      setConfirming(false);
    });

  return (
    <div className="card full channel-form">
      <div className="card-head">
        <span className="card-label">{existing ? 'Mixpanel service account' : 'Connect Mixpanel'}</span>
      </div>
      <p className="card-subtitle">
        Read-only access to the project your app sends events to. Usage syncs hourly with the
        Partner API sync.
      </p>

      <div className="form-stack">
        <div className="field-row">
          <div className="control control-grow">
            <label htmlFor="mp-project">Project ID</label>
            <input
              id="mp-project"
              type="text"
              inputMode="numeric"
              value={projectId}
              placeholder="3323535"
              onChange={(event) => setProjectId(event.target.value)}
              autoComplete="off"
            />
            <span className="field-hint">The number after <code>/project/</code> in your Mixpanel URL.</span>
          </div>
          <div className="control control-narrow">
            <label htmlFor="mp-region">Data region</label>
            <select id="mp-region" value={region} onChange={(event) => setRegion(event.target.value)}>
              <option value="US">US</option>
              <option value="EU">EU</option>
              <option value="IN">India</option>
            </select>
          </div>
        </div>
        <div className="control control-grow">
          <label htmlFor="mp-username">Service account username</label>
          <input
            id="mp-username"
            type="text"
            value={username}
            placeholder="partnerdex.1a2b3c.mp-service-account"
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="control control-grow">
          <label htmlFor="mp-secret">
            Service account secret {existing ? '(leave empty to keep the current one)' : ''}
          </label>
          <input
            id="mp-secret"
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            autoComplete="new-password"
            spellCheck={false}
          />
          <span className="field-hint">
            Mixpanel → Organization settings → Service accounts → <em>Add service account</em>, role{' '}
            <strong>Analyst</strong> on this project (Consumer lacks export permissions). The secret is
            shown once; it is stored here and never sent back to the browser.
          </span>
        </div>
      </div>

      <div className="channel-actions">
        <button
          type="button"
          className="primary"
          onClick={save}
          disabled={busy !== null || !projectId.trim() || !username.trim() || (!existing && !secret.trim())}
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={test} disabled={busy !== null || !existing}>
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" onClick={sync} disabled={busy !== null || !existing}>
          {busy === 'sync' ? 'Syncing…' : 'Sync now'}
        </button>
        {existing ? (
          confirming ? (
            <>
              <button type="button" className="danger" onClick={disconnect} disabled={busy !== null}>
                {busy === 'disconnect' ? 'Disconnecting…' : 'Confirm'}
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} disabled={busy !== null}>
              Disconnect
            </button>
          )
        ) : null}
      </div>

      {error ? <p className="channel-status bad">{error}</p> : null}
      {note ? <p className="channel-status good">{note}</p> : null}
      {!error && !note && existing?.lastError ? (
        <p className="channel-status bad">
          Last sync failed{existing.checkedAt ? ` ${formatDateTime(existing.checkedAt)}` : ''}: {existing.lastError}
        </p>
      ) : null}
      {!error && !note && existing && !existing.lastError && existing.checkedAt ? (
        <p className="channel-status good">Verified {formatDateTime(existing.checkedAt)}.</p>
      ) : null}
      <p className="footnote">
        {payload.stats.latest
          ? `Usage for ${payload.stats.shops} shop(s), ${formatCalendarDate(payload.stats.earliest!)} – ${formatCalendarDate(payload.stats.latest)}.`
          : 'No usage collected yet.'}
      </p>
    </div>
  );
}

function CostModel({
  payload,
  onChanged,
}: {
  payload: MixpanelSettingsPayload;
  onChanged: (next: MixpanelSettingsPayload) => void;
}) {
  const { settings } = payload;
  const [perGeneration, setPerGeneration] = useState(String(settings.costPerGeneration));
  const [perShop, setPerShop] = useState(String(settings.costPerPayingShop));
  const [events, setEvents] = useState(settings.generationEvents.join('\n'));
  const [excluded, setExcluded] = useState(settings.excludedDomains.join('\n'));
  const { busy, error, note, setNote, run } = useAction();

  const save = () =>
    run('save', async () => {
      onChanged(
        await saveMultiplierSettings({
          costPerGeneration: Number(perGeneration),
          costPerPayingShop: Number(perShop),
          generationEvents: events,
          excludedDomains: excluded,
        }),
      );
      setNote('Saved. Multipliers uses these figures from now on.');
    });

  return (
    <div className="card full channel-form">
      <div className="card-head">
        <span className="card-label">Cost model</span>
      </div>
      <p className="card-subtitle">What a customer costs to serve. Revenue minus this is their profit.</p>

      <div className="form-stack">
        <div className="field-row">
          <div className="control control-narrow">
            <label htmlFor="mp-cpg">Cost per generation</label>
            <input
              id="mp-cpg"
              type="number"
              step="0.001"
              min="0"
              value={perGeneration}
              onChange={(event) => setPerGeneration(event.target.value)}
            />
          </div>
          <div className="control control-narrow">
            <label htmlFor="mp-cps">Monthly cost per paying shop</label>
            <input
              id="mp-cps"
              type="number"
              step="0.01"
              min="0"
              value={perShop}
              onChange={(event) => setPerShop(event.target.value)}
            />
          </div>
        </div>
        <div className="control control-grow">
          <label htmlFor="mp-events">Generation events, one per line</label>
          <textarea
            id="mp-events"
            className="bq-key"
            rows={5}
            value={events}
            onChange={(event) => setEvents(event.target.value)}
            spellCheck={false}
          />
          <span className="field-hint">
            Each event counts as one billable generation. Use the raw events, not a merged custom event
            — the export cannot read those.
          </span>
        </div>
        <div className="control control-grow">
          <label htmlFor="mp-excluded">Internal stores to leave out, one per line</label>
          <textarea
            id="mp-excluded"
            className="bq-key"
            rows={4}
            value={excluded}
            onChange={(event) => setExcluded(event.target.value)}
            spellCheck={false}
          />
          <span className="field-hint">
            A store handle or full myshopify domain. <code>*</code> matches anything, so{' '}
            <code>antla-*</code> covers every store starting with it.
          </span>
        </div>
      </div>

      <div className="channel-actions">
        <button type="button" className="primary" onClick={save} disabled={busy !== null}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>
      {error ? <p className="channel-status bad">{error}</p> : null}
      {note ? <p className="channel-status good">{note}</p> : null}
    </div>
  );
}

export function Mixpanel() {
  const [payload, setPayload] = useState<MixpanelSettingsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMixpanel()
      .then(setPayload)
      .catch((cause: Error) => setError(cause.message));
  }, []);

  if (error) {
    return (
      <div className="notice error">
        <h2>Could not load the Mixpanel settings</h2>
        <p>{error}</p>
      </div>
    );
  }
  if (!payload) return <div className="skeleton">Loading Mixpanel settings…</div>;

  return (
    <>
      <Connection payload={payload} onChanged={setPayload} />
      <CostModel payload={payload} onChanged={setPayload} />
    </>
  );
}
