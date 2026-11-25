<script>
  import { onMount } from 'svelte';
  import { NtApi } from '../../lib/api.js';

  let status = null;
  let apiKey = '';
  let busy = false;
  let message = '';
  let failed = false;
  let rows = [];

  const now = new Date();
  let selectedDate = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');

  async function refresh() {
    status = await NtApi.get('/api/wellness/garmin-personal/status');
    const result = await NtApi.get(
      '/api/wellness/fitbit/workouts?date=' + encodeURIComponent(selectedDate)
    );
    if (!Array.isArray(result)) throw new Error('Unexpected workout-list response');
    rows = result.filter(row => row.source === 'garmin_personal');
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    message = '';
    failed = false;
    try {
      await action();
    } catch (error) {
      failed = true;
      message = error?.message || 'Request failed';
      if (apiKey) message = message.split(apiKey).join('[REDACTED]');
      message = message.replace(
        /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
        '[REDACTED TOKEN]'
      );
    } finally {
      busy = false;
    }
  }

  async function connect() {
    try {
      await NtApi.post('/api/wellness/garmin-personal/connect', {
        apiKey: apiKey.trim()
      });
      message = 'Connected. The key is not returned by the server.';
      await refresh();
    } finally {
      apiKey = '';
    }
  }

  async function sync() {
    if (!selectedDate) throw new Error('Select a date first');
    const result = await NtApi.post('/api/wellness/garmin-personal/sync', {
      from: selectedDate,
      to: selectedDate
    });
    await refresh();
    if (result.errors?.length) {
      throw new Error('Some activities failed to import. Inspect the test logs.');
    }
    message = `Processed ${result.imported ?? 0} activities for ${selectedDate}.`;
  }

  async function disconnect() {
    if (!window.confirm('Remove the saved Garmin Personal API credentials? Imported workouts will remain.')) {
      return;
    }
    await NtApi.del('/api/wellness/garmin-personal/disconnect');
    await refresh();
    message = 'Disconnected. Previously imported workouts are retained.';
  }

  function duration(ms) {
    if (ms == null) return '—';
    const seconds = Math.round(ms / 1000);
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  onMount(() => { run(refresh); });
</script>

<div class="card settings-card">
  <div class="setting-row">
    <div>
      <span class="setting-label">Garmin Personal API — Activities</span>
      <div class="setting-desc">
        Personal activity import. Separate from the Garmin Health API integration.
        This version does not import daily wellness totals.
      </div>
    </div>
  </div>

  <div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:12px">
    <div>
      Connection:
      {status === null ? 'Not loaded' : status.connected ? 'Connected' : 'Not connected'}
    </div>

    {#if status?.tokenExpiresAt}
      <div class="setting-desc">
        Token cache deadline: {new Date(status.tokenExpiresAt).toLocaleString()}
      </div>
    {/if}

    <label>
      Personal API key
      <input
        class="input"
        type="password"
        autocomplete="new-password"
        bind:value={apiKey}
        disabled={busy}
        placeholder="Paste a key to connect or replace credentials"
      />
    </label>

    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button
        type="button"
        class="btn btn-primary"
        disabled={busy || !apiKey.trim()}
        on:click={() => run(connect)}
      >Connect / Replace Key</button>
      <button
        type="button"
        class="btn"
        disabled={busy || !status?.connected}
        on:click={() => run(disconnect)}
      >Disconnect</button>
    </div>

    <label>
      Activity date
      <input
        class="input"
        type="date"
        bind:value={selectedDate}
        disabled={busy}
      />
    </label>

    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button
        type="button"
        class="btn"
        disabled={busy || !selectedDate}
        on:click={() => run(refresh)}
      >Load Imported Workouts</button>
      <button
        type="button"
        class="btn btn-primary"
        disabled={busy || !selectedDate || !status?.connected}
        on:click={() => run(sync)}
      >Sync Selected Day</button>
    </div>

    {#if busy}<p role="status">Working…</p>{/if}
    {#if message}
      <p role="status" style:color={failed ? 'var(--danger)' : 'var(--text-2)'}>
        {message}
      </p>
    {/if}

    <div>
      <div class="setting-label">Imported workouts: {rows.length}</div>
      {#each rows as workout (workout.id)}
        <div style="padding:12px 0;border-bottom:1px solid var(--border)">
          <div>{workout.activity_name || workout.activity_type || 'Workout'}</div>
          <div class="setting-desc">
            {workout.date} · {duration(workout.duration_ms)}
            · {workout.distance_km == null ? '—' : workout.distance_km.toFixed(2)} km
            · {workout.calories ?? '—'} kcal
          </div>
          <div class="setting-desc">
            Average HR: {workout.avg_hr ?? '—'} bpm
            · Maximum HR: {workout.max_hr ?? '—'} bpm
          </div>
        </div>
      {/each}
    </div>
  </div>
</div>
