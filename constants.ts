import { ZoneParams, ACUnit } from './types';

/**
 * DEFAULT_ZONE — Zone 1 actual layout (Living Things, Bangalore office).
 * 13 walls tracing the real room perimeter (SE=NW ≈ 11.86 m, NE=SW ≈ 15.47 m).
 * 4 external-facing walls: W1(SE 10.06m), W2(SW 7.01m), W6(NW 4.85m), W10(NE 4.26m).
 * Remaining 9 walls are internal (shared with adjacent conditioned zones).
 * Used as the template when "Add Zone" is clicked.
 */
export const DEFAULT_ZONE: ZoneParams = {
  name: 'Zone 1',
  ceilingHeightM: 2.7,
  isTopFloor: false,
  walls: [
    { id: 'w1',  lengthM: 10.06, direction: 'SE', azimuth: 135, wallType: 'external', constructionType: 'opaque' },
    { id: 'w2',  lengthM: 7.01,  direction: 'SW', azimuth: 225, wallType: 'external', constructionType: 'opaque' },
    { id: 'w3',  lengthM: 2.62,  direction: 'NW', azimuth: 315, wallType: 'internal', constructionType: 'opaque' },
    { id: 'w4',  lengthM: 3.04,  direction: 'SW', azimuth: 225, wallType: 'internal', constructionType: 'opaque' },
    { id: 'w5',  lengthM: 5.42,  direction: 'SW', azimuth: 225, wallType: 'internal', constructionType: 'opaque' },
    { id: 'w6',  lengthM: 4.85,  direction: 'NW', azimuth: 315, wallType: 'external', constructionType: 'opaque' },
    { id: 'w7',  lengthM: 5.59,  direction: 'NE', azimuth: 45,  wallType: 'internal', constructionType: 'opaque' },
    { id: 'w8',  lengthM: 3.70,  direction: 'NE', azimuth: 45,  wallType: 'internal', constructionType: 'opaque' },
    { id: 'w9',  lengthM: 1.92,  direction: 'NE', azimuth: 45,  wallType: 'internal', constructionType: 'opaque' },
    { id: 'w10', lengthM: 4.26,  direction: 'NE', azimuth: 45,  wallType: 'external', constructionType: 'opaque' },
    { id: 'w11', lengthM: 1.70,  direction: 'NW', azimuth: 315, wallType: 'internal', constructionType: 'opaque' },
    { id: 'w12', lengthM: 2.69,  direction: 'NW', azimuth: 315, wallType: 'internal', constructionType: 'opaque' },
    { id: 'w13', lengthM: 1.80,  direction: 'SE', azimuth: 135, wallType: 'internal', constructionType: 'opaque' },
  ],
};

export const DEFAULT_ACS: ACUnit[] = [
  { id: '1', name: 'Split AC Main', ratedCapacityWatts: 6200, iseer: 3.70, ageYears: 2 }
];

export const ORIENTATION_LABELS: Record<string, string> = {
  'N': 'North Wall',
  'NE': 'North-East Wall',
  'E': 'East Wall',
  'SE': 'South-East Wall',
  'S': 'South Wall',
  'SW': 'South-West Wall',
  'W': 'West Wall',
  'NW': 'North-West Wall'
};
