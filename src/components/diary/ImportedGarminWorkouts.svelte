<script>
  import { onDestroy } from 'svelte';
  import { NtApi } from '../../lib/api.js';
  import { Nutrition } from '../../lib/nutrition.js';
  import { currentUser } from '../../stores/auth.js';
  import {
    wellnessEnabled, garminPersonalEnabled, workoutsEnabled, energyUnit
  } from '../../stores/settings.js';

  export let date;

  let rows = [];
  let loading = false;
  let failed = false;
  let version = 0;

  $: enabled = $wellnessEnabled && $garminPersonalEnabled && $workoutsEnabled;
  $: load(date, enabled, $currentUser?.id);

  async function load(selectedDate, visible, userId) {
    const request = ++version;
    rows = [];
    failed = false;
    loading = false;
    if (!visible || !selectedDate) return;
    loading = true;
    try {
      const result = await NtApi.get(
        '/api/wellness/fitbit/workouts?date=' + encodeURIComponent(selectedDate)
      );
      if (!Array.isArray(result)) throw new Error('Unexpected workout response');
      if (request !== version) return;
      rows = result.filter(row => row.source === 'garmin_personal');
    } catch {
      if (request !== version) return;
      failed = true;
    } finally {
      if (request === version) loading = false;
    }
  }

  function duration(ms) {
    if (ms == null) return null;
    const seconds = Math.round(Number(ms) / 1000);
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  onDestroy(() => { version++; });
</script>

{#if enabled}
  {#if loading}
    <p class="text-3 text-sm" role="status" style="padding:0 16px">
      Loading imported workouts…
    </p>
  {:else if failed}
    <p class="text-3 text-sm" role="status" style="padding:0 16px">
      Imported workouts could not be loaded.
    </p>
  {:else if rows.length > 0}
    <div class="imported-workouts">
      <div class="text-3 text-sm">Imported workouts · Garmin Personal</div>
      {#each rows as workout (workout.id)}
        {@const energy = Nutrition.displayEnergy(workout.calories || 0, $energyUnit)}
        <a class="imported-workout" href="#/wellness">
          <span>{workout.activity_name || workout.activity_type || 'Workout'}</span>
          <span class="text-3 text-sm">
            {#if workout.duration_ms != null}{duration(workout.duration_ms)} · {/if}
            {energy.value.toLocaleString()} {energy.unit}
          </span>
        </a>
      {/each}
      <div class="text-3 text-sm">
        Imported energy is shown for reference, not added to your budget by this list.
        Open Wellness and select {date} for workout details.
      </div>
    </div>
  {/if}
{/if}

<style>
  .imported-workouts {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .imported-workout {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 0;
    color: var(--text-1);
    text-decoration: none;
  }
  .imported-workout:hover {
    color: var(--accent);
  }
</style>
