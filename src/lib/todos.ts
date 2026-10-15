// To-do rules shared by the routes, boards and the dashboard.

export const TODO_MAX_AGE_DAYS = 14;
export const TODO_DROP_OFF_TARGET = 90;

const day = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

/** 'YYYY-MM-DD' plus n days. */
export function plusDays(iso: string, n: number): string {
  return new Date(day(iso) + n * 86400000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` ('YYYY-MM-DD' or timestamps), never negative. */
export function ageInDays(from: string, to: string): number {
  return Math.max(0, Math.round((day(to) - day(from)) / 86400000));
}
