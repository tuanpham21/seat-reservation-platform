export const SEED_SEATS = [
  { id: "seat-1", label: "Seat 1", sortOrder: 1 },
  { id: "seat-2", label: "Seat 2", sortOrder: 2 },
  { id: "seat-3", label: "Seat 3", sortOrder: 3 }
] as const;

export type SeedSeatId = (typeof SEED_SEATS)[number]["id"];
