export function addSeconds(date: Date, seconds: number) {
  return new Date(date.getTime() + seconds * 1000);
}

export function addDays(date: Date, days: number) {
  return addSeconds(date, days * 24 * 60 * 60);
}

export function isPast(date: Date, now = new Date()) {
  return date.getTime() <= now.getTime();
}
