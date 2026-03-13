import { ZoneParams, ACUnit } from './types';

export const DEFAULT_ZONE: ZoneParams = {
  name: "Main Office Zone",
  ceilingHeightM: 2.7,
  isTopFloor: false,
  walls: [
    { id: 'w1', lengthM: 10, direction: 'N', azimuth: 0 },
    { id: 'w2', lengthM: 6, direction: 'E', azimuth: 90 },
    { id: 'w3', lengthM: 10, direction: 'S', azimuth: 180 },
    { id: 'w4', lengthM: 6, direction: 'W', azimuth: 270 },
  ],
  windows: [
    { id: 'win1', wallId: 'w1', areaM2: 2 },
    { id: 'win2', wallId: 'w4', areaM2: 1.5 },
  ]
};

export const DEFAULT_ACS: ACUnit[] = [
  { id: '1', name: 'Split AC Main', ratedCapacityWatts: 6200, iseer: 3.70, ageYears: 2 }
];

export const ORIENTATION_LABELS: Record<string, string> = {
  'N': 'North Window',
  'NE': 'North-East Window',
  'E': 'East Window',
  'SE': 'South-East Window',
  'S': 'South Window',
  'SW': 'South-West Window',
  'W': 'West Window',
  'NW': 'North-West Window'
};
