/**
 * internalLoadScheduler.ts
 *
 * Inventory-based internal heat load calculation using per-item schedules.
 *
 * Each item has a SchedulePreset that defines an hourly utilisation factor [0–1].
 * The total heat output per item = count × wattsPerUnit × scheduleFactor(hour).
 *
 * This approach replaces the generic W/m² density method when an actual
 * equipment/people inventory is provided for a zone.
 *
 * Schedule presets:
 *   office_occupancy          – ramp-up 8→9, full 10–16, ramp-down 17→18, zero after 18
 *   office_lighting           – on at 0.4 from 8, full 9–18, 0.4 shoulder at 18, zero after
 *   office_equipment          – 0.1 standby at night, full 9–17, taper 18–20
 *   always_on                 – 0.6 duty-cycle all day (e.g. fridge, server)
 *   intermittent              – office hours only at 0.3 avg utilisation (e.g. shared printer)
 *   extended_office_occupancy – Living Things Bangalore: 10 am → 11 pm; ramp 10, full 11–22, taper 23
 *   early_morning_lighting    – lights from 6 am; 0.4 shoulder 6–9, full 10–22, taper 23, off midnight
 */

import { InternalLoadItem, SchedulePreset } from '../types';

// ─── Schedule factor lookup ───────────────────────────────────────────────────

/**
 * Returns the fraction [0–1] of rated wattage that an item draws at a given hour.
 */
export function getScheduleFactor(preset: SchedulePreset, hour: number): number {
  switch (preset) {
    case 'office_occupancy':
      if (hour < 8)               return 0;
      if (hour === 8)             return 0.2;
      if (hour === 9)             return 0.6;
      if (hour >= 10 && hour <= 16) return 1.0;
      if (hour === 17)            return 0.6;
      if (hour === 18)            return 0.2;
      return 0;

    case 'office_lighting':
      if (hour < 8)               return 0;
      if (hour === 8)             return 0.4;
      if (hour >= 9 && hour <= 17) return 1.0;
      if (hour === 18)            return 0.4;
      return 0;

    case 'office_equipment':
      if (hour < 7)               return 0.1;   // standby / screensaver
      if (hour >= 7 && hour <= 8) return 0.4;   // boot-up / warm-up
      if (hour >= 9 && hour <= 17) return 1.0;  // fully active
      if (hour >= 18 && hour <= 20) return 0.5; // after-hours stragglers
      return 0.1;                               // late-night standby

    case 'always_on':
      // Fridge / server: compressor cycles ~60% duty-cycle on average
      return 0.6;

    case 'intermittent':
      // Printer / shared equipment: office hours only, ~30% avg utilisation
      if (hour < 8 || hour > 18) return 0;
      return 0.3;

    case 'extended_office_occupancy':
      // Living Things Bangalore: office opens 10am, closes 11pm (23:00)
      // hour 10 = arrival / settling in (30%); 11–22 = full occupancy; 23 = final hour (40%)
      if (hour < 10)              return 0;
      if (hour === 10)            return 0.3;
      if (hour >= 11 && hour <= 22) return 1.0;
      if (hour === 23)            return 0.4;
      return 0;  // midnight onwards

    case 'early_morning_lighting':
      // Lights switched on from ~6am for cleaning / early arrivals; full during office hours; off after 11pm
      // hour 6–7 = low (early morning, cleaning): 0.4; 8–9 = ramp up: 0.7; 10–22 = full; 23 = taper: 0.4
      if (hour < 6)               return 0;
      if (hour >= 6 && hour <= 7) return 0.4;
      if (hour >= 8 && hour <= 9) return 0.7;
      if (hour >= 10 && hour <= 22) return 1.0;
      if (hour === 23)            return 0.4;
      return 0;  // midnight onwards

    default:
      return 0;
  }
}

// ─── Aggregated output per category ──────────────────────────────────────────

export interface ScheduledInternalLoads {
  people:    number;   // W  — maps to SimulationDataPoint.peopleLoad
  lighting:  number;   // W  \
  equipment: number;   // W   ├── sum → SimulationDataPoint.internalLoad
  appliance: number;   // W  /
  total:     number;   // W  — sum of all four
}

/**
 * Computes heat output (Watts) for each category at a given hour from an item inventory.
 *
 * @param items           Array of InternalLoadItem (actual zone inventory)
 * @param hour            0-based hour of day (0 = midnight, 12 = noon)
 * @param liveOccupancy   Optional map of liveCountKey → live count value.
 *                        When an item has a `liveCountKey` that matches a key here,
 *                        the live value overrides item.count. This is the hook for
 *                        real-time occupancy data from the DB (e.g. badge reader, CO₂).
 */
export function computeScheduledInternalLoads(
  items: InternalLoadItem[],
  hour: number,
  liveOccupancy?: Record<string, number>
): ScheduledInternalLoads {
  let people    = 0;
  let lighting  = 0;
  let equipment = 0;
  let appliance = 0;

  for (const item of items) {
    const factor = getScheduleFactor(item.schedulePreset, hour);
    // Use live count from DB if available and a liveCountKey is configured; otherwise use default count
    const count  = (item.liveCountKey && liveOccupancy?.[item.liveCountKey] != null)
      ? liveOccupancy[item.liveCountKey]
      : item.count;
    const watts  = count * item.wattsPerUnit * factor;

    switch (item.category) {
      case 'people':    people    += watts; break;
      case 'lighting':  lighting  += watts; break;
      case 'equipment': equipment += watts; break;
      case 'appliance': appliance += watts; break;
    }
  }

  return {
    people,
    lighting,
    equipment,
    appliance,
    total: people + lighting + equipment + appliance,
  };
}

// ─── Comparison helper ────────────────────────────────────────────────────────

/**
 * Returns a text description of why the scheduled approach is preferred
 * (for engineering reports / debug panels).
 */
export function internalLoadMethodDescription(hasInventory: boolean): string {
  return hasInventory
    ? 'Inventory-based scheduled loads (actual item counts × per-unit watts × schedule factor)'
    : 'Density-based estimate (W/m² × floor area × occupancy/lighting/equipment schedule factors)';
}
