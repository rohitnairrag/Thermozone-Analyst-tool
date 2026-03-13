import { ZoneParams, ACUnit } from './types';

export const DEFAULT_ZONE: ZoneParams = {
  name: "Main Office Zone",
  ceilingHeightM: 2.7,
  isTopFloor: false,
  walls: [
    {
      id: 'w1', lengthM: 10, direction: 'N', azimuth: 0,
      wallType: 'external', constructionType: 'mixed',
      windows: [{ id: 'win1', areaM2: 2 }]
    },
    {
      id: 'w2', lengthM: 6, direction: 'E', azimuth: 90,
      wallType: 'external', constructionType: 'opaque'
    },
    {
      id: 'w3', lengthM: 10, direction: 'S', azimuth: 180,
      wallType: 'external', constructionType: 'opaque'
    },
    {
      id: 'w4', lengthM: 6, direction: 'W', azimuth: 270,
      wallType: 'external', constructionType: 'mixed',
      windows: [{ id: 'win2', areaM2: 1.5 }]
    },
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
