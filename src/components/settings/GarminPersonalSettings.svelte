<script>
  import { onMount } from 'svelte';
  import { NtApi } from '../../lib/api.js';
  import { _applySetting, garminPersonalEnabled, workoutsEnabled } from '../../stores/settings.js';

  function setWorkoutVisibility(event) {
    const enabled = event.currentTarget.checked;
    if (enabled) workoutsEnabled.set(true);
    garminPersonalEnabled.set(enabled);
  }

  let status = null;
  let apiKey = '';
  let busy = false;
  let message = '';
  let failed = false;
  let rows = [];
  let importActivitiesEnabled = true;
  let importEnergyEnabled = false;
  let optionsDirty = false;
  let budgetEnabled = false;
  let savedBudgetEnabled = false;
  let budgetDirty = false;
  let budgetLoaded = false;

  function readBudgetOptions(options) {
    if (typeof options?.useEnergyForBudget !== 'boolean') {
      throw new Error('Unexpected Garmin budget-options response');
    }
    _applySetting('garminPersonalUseEnergyForBudget', options.useEnergyForBudget);
    budgetEnabled = options.useEnergyForBudget;
    savedBudgetEnabled = budgetEnabled;
    budgetDirty = false;
    budgetLoaded = true;
  }

  async function saveBudgetOptions() {
    if (!budgetLoaded) throw new Error('Load budget settings first');
    const result = await NtApi.post(
      '/api/wellness/garmin-personal/budget-options',
      { useEnergyForBudget: budgetEnabled }
    );
    if (result?.ok !== true) throw new Error('Budget option was not saved');
    readBudgetOptions(result.budgetOptions);
    status = { ...status, budgetOptions: result.budgetOptions };
    message = 'Budget option saved. No data was imported. ' +
      'Reload Diary to refresh its budget calculations.';
  }

  function readImportOptions(options) {
    if (typeof options?.activities !== 'boolean' ||
        typeof options?.energy !== 'boolean') {
      throw new Error('Unexpected Garmin import-options response');
    }
    importActivitiesEnabled = options.activities;
    importEnergyEnabled = options.energy;
  }

  async function saveImportOptions() {
    const result = await NtApi.post(
      '/api/wellness/garmin-personal/import-options',
      {
        activities: importActivitiesEnabled,
        energy: importEnergyEnabled
      }
    );
    if (result?.ok !== true) throw new Error('Import options were not saved');
    readImportOptions(result.importOptions);
    optionsDirty = false;
    status = { ...status, importOptions: result.importOptions };
    message = 'Import options saved. Existing imported records are retained.';
  }

  const now = new Date();
  let selectedDate = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');

  async function refresh() {
    status = await NtApi.get('/api/wellness/garmin-personal/status');
    if (!optionsDirty) readImportOptions(status.importOptions);
    if (!budgetDirty) readBudgetOptions(status.budgetOptions);
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
    if (optionsDirty) throw new Error('Save import options before syncing');
    if (!importActivitiesEnabled && !importEnergyEnabled) {
      throw new Error('Select at least one import category and save it first');
    }
    const result = await NtApi.post('/api/wellness/garmin-personal/sync', {
      from: selectedDate,
      to: selectedDate
    });
    await refresh();
    const details = [];
    if (result.categories?.activities) {
      const activity = result.categories.activities;
      details.push(activity.ok
        ? `Activities processed: ${activity.imported ?? 0}`
        : 'Activity import failed');
    }
    if (result.categories?.energy) {
      const energy = result.categories.energy;
      details.push(energy.ok
        ? `Energy days: ${energy.importedDays ?? 0}; metric rows: ${energy.metricRows ?? 0}`
        : 'Daily-energy import failed');
    }
    if (result.errors?.length || result.ok === false) {
      failed = true;
      message = `${details.join('. ')}. Some selected data could not be imported.`;
      return;
    }
    message = `${details.join('. ')}. Date: ${selectedDate}.`;
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
      <span class="setting-label">Garmin Personal API</span>
      <div class="setting-desc">
        Choose which supported data to import.
        Separate from the Garmin Health API integration.
      </div>
    </div>
  </div>

  <div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:12px">
    <label style="display:flex;align-items:center;gap:8px">
      <input
        type="checkbox"
        checked={$garminPersonalEnabled}
        on:change={setWorkoutVisibility}
      />
      Show imported workouts in Wellness
    </label>
    <div class="setting-desc">
      Controls workout visibility, not import permission.
      Previously imported records remain after disconnecting.
    </div>
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

    <fieldset disabled={busy || status === null}
      style="border:1px solid var(--border);padding:12px">
      <legend>Data to import</legend>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <input type="checkbox"
          bind:checked={importActivitiesEnabled}
          on:change={() => { optionsDirty = true; }} />
        Import activities
      </label>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <input type="checkbox"
          bind:checked={importEnergyEnabled}
          on:change={() => { optionsDirty = true; }} />
        Import daily energy
      </label>
      <div class="setting-desc">
        Daily energy includes resting, active and total expenditure.
        Import choices do not delete existing records or grant Garmin-side
        API permissions. Calorie-budget participation is controlled
        separately below.
      </div>
      <button type="button" class="btn" class:btn-primary={optionsDirty}
        disabled={busy || !optionsDirty}
        on:click={() => run(saveImportOptions)}
      >Save Import Options</button>
      {#if optionsDirty}
        <p role="status">Unsaved import options. Save before syncing.</p>
      {/if}
    </fieldset>

    <fieldset disabled={busy || !budgetLoaded}
      style="border:1px solid var(--border);padding:12px">
      <legend>Calorie-budget participation</legend>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <input type="checkbox"
          bind:checked={budgetEnabled}
          on:change={event => {
            budgetDirty = event.currentTarget.checked !== savedBudgetEnabled;
          }} />
        Allow Garmin Personal daily energy in calorie-budget calculations
      </label>
      <div class="setting-desc">
        Off by default. Applies to already-imported energy as well as future
        imports; saving this option does not import data or change import choices.
      </div>
      <ul class="setting-desc">
        <li>
          Fixed targets: active energy is eligible only when the separate
          Diary activity-budget adjustment is enabled. Its manual/wearable
          combination policy still applies.
        </li>
        <li>
          Dynamic targets: the previous day's total expenditure is eligible.
          One expenditure source is selected, not summed with other wearables;
          existing source priority and the LiftTrace override still apply.
        </li>
        <li>
          Dynamic and adaptive targets receive no separate activity top-up.
          This option does not directly change the adaptive TDEE estimate.
        </li>
        <li>
          Server-side calculations only. Garmin Personal budget participation
          is not supported in native standalone/local mode.
        </li>
      </ul>
      <div class="setting-desc">
        Turning this off excludes Garmin Personal from those calculations;
        it does not delete imported records. Turning off imports or
        disconnecting does not turn this budget option off.
      </div>
      <button type="button" class="btn" class:btn-primary={budgetDirty}
        disabled={busy || !budgetLoaded || !budgetDirty}
        on:click={() => run(saveBudgetOptions)}
      >Save Budget Option</button>
      {#if budgetDirty}
        <p role="status">
          Unsaved budget option. Current calculations still use the saved value.
        </p>
      {/if}
    </fieldset>

    <label>
      Import date
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
        disabled={busy || !selectedDate || !status?.connected ||
          optionsDirty || (!importActivitiesEnabled && !importEnergyEnabled)}
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
