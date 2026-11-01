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

// ── The seat tree and its extra-parent links ────────────────────────────────

export type ReparentSeat = { id: string; parent_id: string | null };

/** One extra reporting line: `seat_id` also reports to `parent_id`. */
export type SeatLink = { seat_id: string; parent_id: string };

/**
 * Whether the seat may move under `newParentId` (null = root). Rejects a seat
 * parenting itself, a parent outside this chart, a parent that would make the
 * seat its own ancestor (through primary or extra edges), and a second root —
 * each chart keeps exactly one.
 */
export function validateReparent(
  seats: ReparentSeat[],
  id: string,
  newParentId: string | null,
  links: SeatLink[] = []
): { ok: true } | { error: string } {
  const seat = seats.find((s) => s.id === id);
  if (!seat) return { error: 'Seat not found' };
  if (newParentId === id) return { error: 'A seat cannot be its own parent' };
  if (newParentId === null) {
    return seat.parent_id === null ? { ok: true } : { error: 'A chart has one root' };
  }
  const parent = seats.find((s) => s.id === newParentId);
  if (!parent) return { error: 'Parent not found in this chart' };
  // Everything reachable below the seat through primary and extra edges; a
  // new parent drawn from that set would loop the chart.
  if (descendantIds(seats, id, links).has(newParentId)) {
    return { error: 'That move would loop the chart' };
  }
  return { ok: true };
}

// ── Drag to re-parent and the Reports-to list ───────────────────────────────

/**
 * A seat and every seat below it through primary and extra edges (what can
 * never be its parent). Without `links` this is the primary-parent subtree,
 * which is exactly what a delete's cascade removes.
 */
export function descendantIds(seats: ReparentSeat[], id: string, links: SeatLink[] = []): Set<string> {
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
    for (const l of links) {
      if (out.has(l.parent_id) && !out.has(l.seat_id)) {
        out.add(l.seat_id);
        grew = true;
      }
    }
  }
  return out;
}

/** Every seat that may become `seatId`'s parent: all seats but itself and its descendants. */
export function allowedParentIds(seats: ReparentSeat[], seatId: string, links: SeatLink[] = []): string[] {
  const banned = descendantIds(seats, seatId, links);
  return seats.filter((s) => !banned.has(s.id)).map((s) => s.id);
}

/**
 * The extra parent a child keeps when its primary parent is deleted: the
 * first link (by created_at — the caller's order) whose parent is not in the
 * doomed set, or null when every extra parent dies with the delete (the child
 * goes with the subtree). `doomed` is primary-parent reachability, what the
 * database cascade actually removes.
 */
export function survivingExtraParent(
  links: SeatLink[],
  childId: string,
  doomed: Set<string>
): string | null {
  for (const l of links) {
    if (l.seat_id === childId && !doomed.has(l.parent_id)) return l.parent_id;
  }
  return null;
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
  rects: Record<string, DropRect>,
  links: SeatLink[] = []
): string | null {
  const banned = descendantIds(seats, draggedId, links);
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
 * order (sort_order, then title, then id), one edge per parent link (primary
 * plus extra, deduped), parent ids that point outside the chart dropped.
 * Positions come back keyed by id.
 */
export function buildLayout(
  seats: Array<Pick<SeatRow, 'id' | 'parent_id' | 'title' | 'sort_order'>>,
  layout: (nodes: LayoutNode[], edges: LayoutEdge[]) => LayoutPositions,
  links: SeatLink[] = []
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
  const seen = new Set(edges.map((e) => `${e.source}->${e.target}`));
  for (const l of links) {
    const key = `${l.parent_id}->${l.seat_id}`;
    if (ids.has(l.parent_id) && ids.has(l.seat_id) && !seen.has(key)) {
      edges.push({ source: l.parent_id, target: l.seat_id });
      seen.add(key);
    }
  }
  return layout(nodes, edges);
}

export type SeatEdge = {
  id: string;
  source: string;
  target: string;
  type: 'smoothstep';
  dashed: boolean;
  /** True for an extra-parent connector (an accountability_seat_links row). */
  extra: boolean;
};

const titleKey = (t: string) => t.trim().toLowerCase();

/**
 * One edge per parent link: the primary parent first, then every extra-parent
 * link (flagged `extra` so the UI can style it apart). The Visionary →
 * Integrator connector is dashed; every other connector is solid. All
 * connectors are smoothstep.
 */
export function edgesFromSeats(
  seats: Array<Pick<SeatRow, 'id' | 'parent_id' | 'title'>>,
  links: SeatLink[] = []
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
      extra: false,
    });
  }
  for (const l of links) {
    if (!titles.has(l.parent_id) || !titles.has(l.seat_id)) continue;
    out.push({
      id: `link-${l.parent_id}-${l.seat_id}`,
      source: l.parent_id,
      target: l.seat_id,
      type: 'smoothstep',
      dashed: false,
      extra: true,
    });
  }
  return out;
}
