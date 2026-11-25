<script>
  import { onDestroy } from 'svelte';
  import { NtApi } from '../../lib/api.js';
  import { Nutrition } from '../../lib/nutrition.js';
  import { energyUnit } from '../../stores/settings.js';

  export let date;

  let metrics = {};
  let loadedDate = null;
  let loading = false;
  let error = '';
  let requestId = 0;
  let destroyed = false;

  const definitions = [
    { id: 'resting_calories', label: 'Resting energy' },
    { id: 'active_calories', label: 'Active energy' },
    { id: 'calories_out', label: 'Total expenditure' },
  ];

  async function load(selectedDate) {
    const request = ++requestId;
    metrics = {};
    loadedDate = null;
    error = '';
    loading = false;
    if (!selectedDate) return;

    loading = true;
    try {
      const response = await NtApi.get(
        '/api/wellness/garmin-personal/data?date=' +
        encodeURIComponent(selectedDate)
      );
      if (destroyed || request !== requestId) return;

      const values = response?.[selectedDate] || {};
      const next = {};
      for (const definition of definitions) {
        const value = values[definition.id];
        if (typeof value === 'number' &&
            Number.isFinite(value) && value >= 0) {
          next[definition.id] = value;
        }
      }
      metrics = next;
      loadedDate = selectedDate;
    } catch {
      if (destroyed || request !== requestId) return;
      error = 'Could not load imported Garmin Personal energy.';
    } finally {
      if (!destroyed && request === requestId) loading = false;
    }
  }

  $: load(date);

  onDestroy(() => {
    destroyed = true;
    requestId++;
  });
</script>

{#if loading}
  <p role="status">Loading Garmin Personal energy…</p>
{:else if error}
  <p role="status">{error}</p>
{:else if loadedDate === date && Object.keys(metrics).length}
  <section class="card personal-energy" aria-label="Garmin Personal daily energy">
    <h3>Garmin Personal — daily energy</h3>
    <p class="energy-note">
      Imported for {date}. Total expenditure includes resting and active energy.
      These are source-specific values, not an additional calorie allowance.
    </p>
    <dl>
      {#each definitions as definition (definition.id)}
        {#if metrics[definition.id] != null}
          {@const energy = Nutrition.displayEnergy(metrics[definition.id], $energyUnit)}
          <div class="energy-row">
            <dt>{definition.label}</dt>
            <dd>{energy.value.toLocaleString()} {energy.unit}</dd>
          </div>
        {/if}
      {/each}
    </dl>
  </section>
{/if}

<style>
  .personal-energy { margin-top: 12px; padding: 16px; }
  h3 { margin: 0 0 8px; font-size: 16px; }
  .energy-note { color: var(--text-2); font-size: 13px; margin: 0 0 12px; }
  dl { margin: 0; }
  .energy-row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 8px 0;
    border-top: 1px solid var(--border);
  }
  dt { color: var(--text-2); }
  dd { margin: 0; font-variant-numeric: tabular-nums; }
</style>
