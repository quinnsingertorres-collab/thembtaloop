// Mirrors the car-numbering ranges used for detection in green-line-tracker.html.

export const CAR_TYPE_RANGES = [
  { type: 'Type 7', start: 3600, end: 3719 },
  { type: 'Type 8', start: 3800, end: 3899 },
  { type: 'Type 9', start: 3900, end: 3923 },
  { type: 'Type 10', start: 4001, end: 4102 }
];

export const PCC_CAR_NUMBERS = new Set([
  '3087', '3230', '3234', '3238', '3254', '3260', '3262', '3263', '3265', '3268'
]);

// Pride train car — update here if the number ever changes.
export const PRIDE_CAR_NUMBER = '3706';

export function getCarType(carNumStr) {
  const str = String(carNumStr);
  if (PCC_CAR_NUMBERS.has(str)) return 'PCC';
  const n = parseInt(str, 10);
  if (Number.isNaN(n)) return 'Unknown';
  for (const r of CAR_TYPE_RANGES) {
    if (n >= r.start && n <= r.end) return r.type;
  }
  return 'Unknown';
}
