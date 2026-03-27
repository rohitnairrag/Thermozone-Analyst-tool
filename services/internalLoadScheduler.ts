/**
 * internalLoadScheduler.ts
 *
 * Time-range-based internal heat load calculation.
 *
 * Each item has an explicit startTime / endTime ("HH:MM", both inclusive).
 * The item contributes count × wattsPerUnit watts during [startTime, endTime]
 * and zero watts outside that window.
 *
 * This replaces the old schedule-preset approach, giving users direct control
 * over when each item is active rather than relying on generic preset curves.
 */

import { InternalLoadItem } from '../types';

// ─── Time-range active check ──────────────────────────────────────────────────

/**
 * Returns true if slotNumber (0–1439) falls within the item's [startTime, endTime] window.
 * Both endpoints are inclusive. Handles midnight-crossing ranges (e.g. "22:00" to "02:00").
 */
function isSlotActive(item: InternalLoadItem, slotNumber: number): boolean {
  const [sh, sm] = item.startTime.split(':').map(Number);
  const [eh, em] = item.endTime.split(':').map(Number);
  const startSlot = sh * 60 + sm;
  const endSlot   = eh * 60 + em;

  if (startSlot <= endSlot) {
    return slotNumber >= startSlot && slotNumber <= endSlot;
  }
  // Midnight-crossing (e.g. 22:00–02:00)
  return slotNumber >= startSlot || slotNumber <= endSlot;
}

// ─── Aggregated output per category ──────────────────────────────────────────

export interface ScheduledInternalLoads {
  people:    number;   // W
  lighting:  number;   // W
  equipment: number;   // W
  appliance: number;   // W
  total:     number;   // W
}

/**
 * Computes active heat output (Watts) per category at a given minute slot.
 *
 * @param items      Array of InternalLoadItem (zone inventory)
 * @param slotNumber Minute-of-day index 0–1439 (0 = 00:00, 600 = 10:00, etc.)
 */
export function computeTimeRangeInternalLoads(
  items: InternalLoadItem[],
  slotNumber: number,
): ScheduledInternalLoads {
  let people    = 0;
  let lighting  = 0;
  let equipment = 0;
  let appliance = 0;

  for (const item of items) {
    if (!isSlotActive(item, slotNumber)) continue;
    const watts = item.count * item.wattsPerUnit;
    switch (item.category) {
      case 'people':    people    += watts; break;
      case 'lighting':  lighting  += watts; break;
      case 'equipment': equipment += watts; break;
      case 'appliance': appliance += watts; break;
    }
  }

  return { people, lighting, equipment, appliance, total: people + lighting + equipment + appliance };
}

// ─── Description helper ───────────────────────────────────────────────────────

export function internalLoadMethodDescription(hasInventory: boolean): string {
  return hasInventory
    ? 'Inventory-based time-range loads (actual item counts × per-unit watts × active window)'
    : 'Density-based estimate (W/m² × floor area × occupancy/lighting/equipment schedule factors)';
}
