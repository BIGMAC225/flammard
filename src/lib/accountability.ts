// Accountability chart: pure helpers shared by the /api/accountability routes
// and the chart UI. No database access, so everything here runs in node:test;
// the routes load seats and resolve people themselves.

/** The EOS rule the seed follows: a seat lists five roles at most. */
export const MAX_ROLES = 5;

export type ChartStatus = 'current' | 'proposal';

export type ChartRow = {
  id: string;
  title: string;
  status: ChartStatus;
  created_at: string;
  updated_at: string;
};

export type SeatRow = {
  id: string;
  chart_id: string;
  parent_id: string | null;
  title: string;
  roles: string[];
  notes: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type SeatPersonRow = {
  id?: string;
  seat_id: string;
  person_id: string | null;
  person: string | null;
  sort_order: number;
};

// ── Roles and people text ───────────────────────────────────────────────────

/** Trims roles, drops blanks and non-strings, keeps the first five. */
export function sanitizeRoles(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((r): r is string => typeof r === 'string')
    .map((r) => r.trim())
    .filter((r) => r !== '')
    .slice(0, MAX_ROLES);
}

/**
 * Splits ';'-joined names (the seed format; an array of strings works too),
 * trims, drops blanks and keeps the first occurrence of each name. The index
 * in the result is the seat-person row's sort_order.
 */
export function normalizePeople(input: unknown): string[] {
  const parts = typeof input === 'string' ? [input] : Array.isArray(input) ? input : [];
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    for (const name of part.split(';')) {
      const trimmed = name.trim();
      if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
    }
  }
  return out;
}

// ── The seat tree ───────────────────────────────────────────────────────────

export type ReparentSeat = { id: string; parent_id: string | null };

/**
 * Whether the seat may move under `newParentId` (null = root). Rejects a seat
 * parenting itself, a parent outside this chart, a parent that would make the
 * seat its own ancestor, and a second root — each chart keeps exactly one.
 */
export function validateReparent(
  seats: ReparentSeat[],
  id: string,
  newParentId: string | null
): { ok: true } | { error: string } {
  const seat = seats.find((s) => s.id === id);
  if (!seat) return { error: 'Seat not found' };
  if (newParentId === id) return { error: 'A seat cannot be its own parent' };
  if (newParentId === null) {
    return seat.parent_id === null ? { ok: true } : { error: 'A chart has one root' };
  }
  const parent = seats.find((s) => s.id === newParentId);
  if (!parent) return { error: 'Parent not found in this chart' };
  // Walk up from the new parent; meeting the seat again would loop the tree.
  // The seen set stops the walk if the stored rows ever carry a loop.
  const seen = new Set<string>();
  let cursor: ReparentSeat | undefined = parent;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const parentId: string | null = cursor.parent_id;
    if (parentId === id) return { error: 'That move would loop the tree' };
    cursor = parentId ? seats.find((s) => s.id === parentId) : undefined;
  }
  return { ok: true };
}

// ── Drag to re-parent and the Reports-to list ───────────────────────────────

/** A seat and every seat below it (what a delete removes, what can never be its parent). */
export function descendantIds(seats: ReparentSeat[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of seats) {
      if (s.parent_id && out.has(s.parent_id) && !out.has(s.id)) {
        out.add(s.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Every seat that may become `seatId`'s parent: all seats but itself and its descendants. */
export function allowedParentIds(seats: ReparentSeat[], seatId: string): string[] {
  const banned = descendantIds(seats, seatId);
  return seats.filter((s) => !banned.has(s.id)).map((s) => s.id);
}

/** A card's box in flow coordinates: top-left corner plus the rendered size. */
export type DropRect = { x: number; y: number; width: number; height: number };

/**
 * The seat whose card sits under the drag pointer, ignoring the dragged seat
 * and its descendants (they can never be the new parent; the caller still
 * re-checks with validateReparent). Null when the pointer is over empty canvas.
 */
export function pickDropTarget(
  seats: ReparentSeat[],
  draggedId: string,
  pointer: { x: number; y: number },
  rects: Record<string, DropRect>
): string | null {
  const banned = descendantIds(seats, draggedId);
  for (const seat of seats) {
    if (banned.has(seat.id)) continue;
    const rect = rects[seat.id];
    if (!rect) continue;
    if (
      pointer.x >= rect.x &&
      pointer.x <= rect.x + rect.width &&
      pointer.y >= rect.y &&
      pointer.y <= rect.y + rect.height
    ) {
      return seat.id;
    }
  }
  return null;
}

// ── Layout and edges ────────────────────────────────────────────────────────

/** Card size the layout assumes; v1 stores no x/y, the layout is computed. */
export const SEAT_NODE_WIDTH = 240;
export const SEAT_NODE_HEIGHT = 110;

export type LayoutNode = { id: string; width: number; height: number };
export type LayoutEdge = { source: string; target: string };
export type LayoutPositions = Record<string, { x: number; y: number }>;

/**
 * Computes seat positions through an injected layout function (dagre,
 * top-to-bottom, in the UI — the lib stays dependency-free and testable).
 * buildLayout normalises what the function sees: seats in a deterministic
 * order (sort_order, then title, then id), one edge per parent link, parent
 * ids that point outside the chart dropped. Positions come back keyed by id.
 */
export function buildLayout(
  seats: Array<Pick<SeatRow, 'id' | 'parent_id' | 'title' | 'sort_order'>>,
  layout: (nodes: LayoutNode[], edges: LayoutEdge[]) => LayoutPositions
): LayoutPositions {
  const byTitle = (a: { title: string }, b: { title: string }) =>
    a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  const ordered = [...seats].sort(
    (a, b) =>
      a.sort_order - b.sort_order ||
      byTitle(a, b) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const ids = new Set(ordered.map((s) => s.id));
  const nodes: LayoutNode[] = ordered.map((s) => ({
    id: s.id,
    width: SEAT_NODE_WIDTH,
    height: SEAT_NODE_HEIGHT,
  }));
  const edges: LayoutEdge[] = ordered
    .filter((s) => s.parent_id !== null && ids.has(s.parent_id))
    .map((s) => ({ source: s.parent_id as string, target: s.id }));
  return layout(nodes, edges);
}

export type SeatEdge = {
  id: string;
  source: string;
  target: string;
  type: 'smoothstep';
  dashed: boolean;
};

const titleKey = (t: string) => t.trim().toLowerCase();

/**
 * One edge per parent link. The Visionary → Integrator connector is dashed;
 * every other connector is solid. All connectors are smoothstep.
 */
export function edgesFromSeats(
  seats: Array<Pick<SeatRow, 'id' | 'parent_id' | 'title'>>
): SeatEdge[] {
  const titles = new Map(seats.map((s) => [s.id, titleKey(s.title)]));
  const out: SeatEdge[] = [];
  for (const seat of seats) {
    if (seat.parent_id === null || !titles.has(seat.parent_id)) continue;
    const dashed =
      titles.get(seat.parent_id) === 'visionary' && titles.get(seat.id) === 'integrator';
    out.push({
      id: `${seat.parent_id}-${seat.id}`,
      source: seat.parent_id,
      target: seat.id,
      type: 'smoothstep',
      dashed,
    });
  }
  return out;
}
