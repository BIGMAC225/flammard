import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getNodesBounds,
  getViewportForBounds,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { graphlib, layout as runDagre } from '@dagrejs/dagre';
import { toPng } from 'html-to-image';
import '@xyflow/react/dist/style.css';
import {
  MAX_ROLES,
  SEAT_NODE_WIDTH,
  allowedParentIds,
  buildLayout,
  descendantIds,
  edgesFromSeats,
  normalizePeople,
  pickDropTarget,
  sanitizeRoles,
  validateReparent,
  type ChartRow,
  type DropRect,
  type LayoutEdge,
  type LayoutNode,
  type LayoutPositions,
  type SeatLink,
  type SeatPersonRow,
  type SeatRow,
} from '../lib/accountability';

// The Accountability Chart island: one chart's seats on a React Flow canvas.
// The seats array plus the extra-parent links are the source of truth; nodes
// and edges are derived from them and recomputed after every change (dagre,
// top to bottom; no stored x/y). Saves are optimistic with rollback on error
// (the RocksPanel pattern) so the viewport survives edits.

export type SeatWithPeople = SeatRow & { people: SeatPersonRow[] };

interface AccountabilityChartProps {
  chart: ChartRow;
  seats: SeatWithPeople[];
  /** Extra reporting lines (accountability_seat_links rows) for this chart. */
  links: SeatLink[];
  /** Whether this principal may promote a proposal; the server re-checks. */
  canPromote?: boolean;
}

// Cards clip their content to about this height (title, up to four one-line
// names, five one-line roles), so every rank is laid out as if its tallest
// card were this tall and ranks never overlap.
const LAYOUT_NODE_HEIGHT = 200;
const EDGE_STROKE = '#94a3b8';
// Extra-parent connectors are lighter than the primary line so the tree stays
// the obvious structure (the Visionary → Integrator dash is kept for primary).
const EXTRA_EDGE_STROKE = '#cbd5e1';

/** The layout function buildLayout calls: dagre, top to bottom. */
function dagreLayout(nodes: LayoutNode[], edges: LayoutEdge[]): LayoutPositions {
  const graph = new graphlib.Graph();
  graph.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.id, { width: node.width, height: LAYOUT_NODE_HEIGHT });
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  runDagre(graph);
  const positions: LayoutPositions = {};
  for (const node of nodes) {
    const placed = graph.node(node.id);
    // dagre returns centers; React Flow positions are top-left corners.
    positions[node.id] = { x: placed.x - node.width / 2, y: placed.y - LAYOUT_NODE_HEIGHT / 2 };
  }
  return positions;
}

const namesOf = (seat: SeatWithPeople): string[] =>
  (seat.people ?? []).map((p) => p.person).filter((n): n is string => !!n);

/** Seat titles indented by depth, for the add form's parent picker. */
function seatOptions(seats: SeatWithPeople[]): Array<{ id: string; label: string }> {
  const byParent = new Map<string | null, SeatWithPeople[]>();
  for (const s of seats) {
    const list = byParent.get(s.parent_id) ?? [];
    list.push(s);
    byParent.set(s.parent_id, list);
  }
  const out: Array<{ id: string; label: string }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const s of byParent.get(parent) ?? []) {
      out.push({ id: s.id, label: `${'  '.repeat(depth)}${s.title}` });
      walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

type SeatNodeData = {
  title: string;
  names: string[];
  roles: string[];
  notes: string | null;
  editing: boolean;
  /** True while a dragged card's pointer is over this seat: the drop target. */
  dropTarget: boolean;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
};

type SeatFlowNode = Node<SeatNodeData, 'seat'>;

function SeatNode({ id, data }: NodeProps<SeatFlowNode>) {
  const { title, names, roles, notes, editing, dropTarget, onEdit, onDelete } = data;
  const tooltip = [title, names.join('; '), ...roles, notes ?? ''].filter((s) => s !== '').join('\n');
  return (
    <div
      className={`w-[240px] max-h-[200px] overflow-hidden rounded-xl border bg-bg-surface shadow-card px-3 py-2 ${
        dropTarget
          ? 'border-accent ring-2 ring-accent/50'
          : editing
            ? 'border-accent ring-2 ring-accent/30'
            : 'border-line'
      }`}
      title={tooltip}
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-line" />
      <div className="flex items-start justify-between gap-1">
        <p className="text-sm font-medium text-ink-primary truncate">{title}</p>
        <div className="nodrag flex gap-0.5 shrink-0">
          <button
            onClick={() => onEdit(id)}
            className="text-ink-muted hover:text-ink-primary p-0.5"
            aria-label={`Edit ${title}`}
            title="Edit seat"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            onClick={() => onDelete(id)}
            className="text-ink-muted hover:text-state-danger p-0.5"
            aria-label={`Delete ${title}`}
            title="Delete seat (removes everything below it)"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
      {names.length === 0 ? (
        <p className="text-xs text-ink-muted italic">Open seat</p>
      ) : (
        <div className="mt-0.5 flex items-start gap-1.5">
          <div className="min-w-0 flex-1">
            {names.map((name) => (
              <p key={name} className="text-xs text-ink-secondary truncate">
                {name}
              </p>
            ))}
          </div>
          {names.length > 1 && (
            <span
              className="mt-0.5 shrink-0 rounded-full border border-state-warning/30 bg-state-warning/15 px-1.5 py-px text-[10px] font-medium text-state-warning"
              title="Two or more names share this seat: a defect to resolve"
            >
              shared
            </span>
          )}
        </div>
      )}
      {roles.length > 0 && (
        <ul className="mt-1">
          {roles.slice(0, MAX_ROLES).map((role) => (
            <li key={role} className="text-[11px] leading-snug text-ink-muted truncate">
              &bull; {role}
            </li>
          ))}
        </ul>
      )}
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-line" />
    </div>
  );
}

const nodeTypes = { seat: SeatNode };

function seatsToNodes(
  seats: SeatWithPeople[],
  links: SeatLink[],
  editingId: string | null,
  onEdit: (id: string) => void,
  onDelete: (id: string) => void
): SeatFlowNode[] {
  const positions = buildLayout(seats, dagreLayout, links);
  return seats.map((seat) => ({
    id: seat.id,
    type: 'seat' as const,
    position: positions[seat.id] ?? { x: 0, y: 0 },
    data: {
      title: seat.title,
      names: namesOf(seat),
      roles: seat.roles ?? [],
      notes: seat.notes,
      editing: editingId === seat.id,
      dropTarget: false,
      onEdit,
      onDelete,
    },
  }));
}

export default function AccountabilityChart(props: AccountabilityChartProps) {
  return (
    <ReactFlowProvider>
      <Chart {...props} />
    </ReactFlowProvider>
  );
}

function Chart({ chart, seats: initialSeats, links: initialLinks, canPromote = false }: AccountabilityChartProps) {
  const [seats, setSeats] = useState<SeatWithPeople[]>(initialSeats);
  const [links, setLinks] = useState<SeatLink[]>(initialLinks);
  const [nodes, setNodes, onNodesChange] = useNodesState<SeatFlowNode>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [formTitle, setFormTitle] = useState('');
  const [formPeople, setFormPeople] = useState('');
  const [formRoles, setFormRoles] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [formParent, setFormParent] = useState('');
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const wrapper = useRef<HTMLDivElement>(null);
  const didFit = useRef(false);
  const rf = useReactFlow();

  const closeForm = () => {
    setAdding(false);
    setEditingId(null);
    setError('');
  };

  const startEdit = (id: string) => {
    const seat = seats.find((s) => s.id === id);
    if (!seat) return;
    setAdding(false);
    setEditingId(id);
    setFormTitle(seat.title);
    setFormPeople(namesOf(seat).join('; '));
    setFormRoles((seat.roles ?? []).join('\n'));
    setFormNotes(seat.notes ?? '');
    setError('');
  };

  const startAdd = () => {
    const root = seats.find((s) => s.parent_id === null);
    setEditingId(null);
    setAdding(true);
    setFormTitle('');
    setFormPeople('');
    setFormRoles('');
    setFormNotes('');
    setFormParent(root ? root.id : '');
    setError('');
  };

  const deleteSeat = (id: string) => {
    const seat = seats.find((s) => s.id === id);
    if (!seat) return;
    const below = descendantIds(seats, id);
    const count = below.size - 1;
    const label =
      count > 0 ? `"${seat.title}" and the ${count} seat${count === 1 ? '' : 's'} below it` : `"${seat.title}"`;
    if (!window.confirm(`Delete ${label}?`)) return;
    const prev = seats;
    const prevLinks = links;
    setSeats(seats.filter((s) => !below.has(s.id)));
    setLinks(links.filter((l) => !below.has(l.seat_id) && !below.has(l.parent_id)));
    if (editingId && below.has(editingId)) closeForm();
    void (async () => {
      const res = await fetch(`/api/accountability/seats/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        setSeats(prev);
        setLinks(prevLinks);
        setError('Could not delete the seat');
        return;
      }
      // The server promotes children with a surviving extra parent instead of
      // deleting them; re-read the chart for the authoritative seats and links.
      const fresh = await fetch(`/api/accountability?status=${chart.status}`);
      if (!fresh.ok) return;
      const payload = await fresh.json();
      setSeats(payload.seats);
      setLinks(payload.links ?? []);
    })();
  };

  /** True when the optimistic move happened (the caller snaps the card back when not). */
  const reparent = (id: string, parentId: string): boolean => {
    const seat = seats.find((s) => s.id === id);
    if (!seat || seat.parent_id === parentId) return false;
    const check = validateReparent(
      seats.map((s) => ({ id: s.id, parent_id: s.parent_id })),
      id,
      parentId,
      links
    );
    if ('error' in check) {
      setError(check.error);
      return false;
    }
    const prev = seats;
    const prevLinks = links;
    setSeats(seats.map((s) => (s.id === id ? { ...s, parent_id: parentId } : s)));
    // The new primary parent stops being an extra parent (the server agrees).
    setLinks(links.filter((l) => !(l.seat_id === id && l.parent_id === parentId)));
    setError('');
    void (async () => {
      const res = await fetch(`/api/accountability/seats/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_id: parentId }),
      });
      if (!res.ok) {
        setSeats(prev);
        setLinks(prevLinks);
        const payload = await res.json().catch(() => ({}));
        setError(payload.error ?? 'Could not move the seat');
      }
    })();
    return true;
  };

  /** Toggles one "Also reports to" extra parent: the full set goes back as
   *  PATCH extra_parent_ids (optimistic, rolled back on error). */
  const toggleExtraParent = (seatId: string, parentId: string) => {
    const current = links.filter((l) => l.seat_id === seatId).map((l) => l.parent_id);
    const next = current.includes(parentId)
      ? current.filter((p) => p !== parentId)
      : [...current, parentId];
    const prev = links;
    setLinks(
      current.includes(parentId)
        ? links.filter((l) => !(l.seat_id === seatId && l.parent_id === parentId))
        : [...links, { seat_id: seatId, parent_id: parentId }]
    );
    setError('');
    void (async () => {
      const res = await fetch(`/api/accountability/seats/${seatId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra_parent_ids: next }),
      });
      if (!res.ok) {
        setLinks(prev);
        const payload = await res.json().catch(() => ({}));
        setError(payload.error ?? 'Could not save the extra parent');
      }
    })();
  };

  // Nodes and edges follow the seats and links: layout recomputes after every
  // change. fitView runs on the first layout only, so later changes keep the
  // viewport.
  useEffect(() => {
    setNodes(seatsToNodes(seats, links, editingId, startEdit, deleteSeat));
    if (didFit.current) return;
    didFit.current = true;
    const frame = window.requestAnimationFrame(() => rf.fitView({ padding: 0.12, duration: 200 }));
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seats, links, editingId]);

  const edges = useMemo<Edge[]>(
    () =>
      edgesFromSeats(seats, links).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'smoothstep',
        style: {
          stroke: e.extra ? EXTRA_EDGE_STROKE : EDGE_STROKE,
          strokeWidth: 1.5,
          ...(e.dashed ? { strokeDasharray: '8 5' } : {}),
        },
      })),
    [seats, links]
  );

  /** The drag pointer in flow coordinates, or null when a touch has no active point. */
  const pointerToFlow = (event: MouseEvent | TouchEvent) => {
    const src = 'clientX' in event ? event : event.touches[0];
    return src ? rf.screenToFlowPosition({ x: src.clientX, y: src.clientY }) : null;
  };

  /** Each seat's card box in flow coordinates, at its current (dragged) position. */
  const dropRects = (): Record<string, DropRect> => {
    const out: Record<string, DropRect> = {};
    for (const n of rf.getNodes()) {
      out[n.id] = {
        x: n.position.x,
        y: n.position.y,
        width: n.measured?.width ?? SEAT_NODE_WIDTH,
        height: n.measured?.height ?? LAYOUT_NODE_HEIGHT,
      };
    }
    return out;
  };

  /** Highlights the card under the pointer without touching node positions. */
  const setDropTarget = (id: string | null) => {
    if (dropTargetId === id) return;
    setDropTargetId(id);
    setNodes((prev) => prev.map((n) => ({ ...n, data: { ...n.data, dropTarget: n.id === id } })));
  };

  /** While dragging, the card under the pointer (never the dragged seat or its
   *  descendants) highlights as the drop target. */
  const onNodeDrag = (event: MouseEvent | TouchEvent, dragged: SeatFlowNode) => {
    const pointer = pointerToFlow(event);
    if (!pointer) return;
    setDropTarget(pickDropTarget(seats, dragged.id, pointer, dropRects(), links));
  };

  /** Drop on a highlighted card = re-parent; drop anywhere else = snap back to
   *  the layout position, no request. */
  const onNodeDragStop = (event: MouseEvent | TouchEvent, dragged: SeatFlowNode) => {
    const pointer = pointerToFlow(event);
    const targetId = pointer ? pickDropTarget(seats, dragged.id, pointer, dropRects(), links) : null;
    setDropTarget(null);
    const moved = targetId ? reparent(dragged.id, targetId) : false;
    if (!moved) setNodes(seatsToNodes(seats, links, editingId, startEdit, deleteSeat));
  };

  const saveForm = async () => {
    if (!formTitle.trim()) {
      setError('Title required');
      return;
    }
    setError('');
    const people = normalizePeople(formPeople);
    const roles = sanitizeRoles(formRoles.split('\n'));
    const notes = formNotes.trim() ? formNotes.trim() : null;

    if (editingId) {
      const seat = seats.find((s) => s.id === editingId);
      if (!seat) return;
      setSaving(true);
      const body = { title: formTitle.trim(), people, roles, notes };
      const optimistic: SeatWithPeople = {
        ...seat,
        ...body,
        people: people.map((person, i) => ({ seat_id: seat.id, person_id: null, person, sort_order: i })),
      };
      const prev = seats;
      setSeats(seats.map((s) => (s.id === seat.id ? optimistic : s)));
      const res = await fetch(`/api/accountability/seats/${seat.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      setSaving(false);
      if (!res.ok) {
        setSeats(prev);
        setError(payload.error ?? 'Could not save the seat');
        return;
      }
      setSeats(prev.map((s) => (s.id === seat.id ? payload.seat : s)));
      closeForm();
    } else {
      setSaving(true);
      const parentId =
        seats.length === 0 ? null : formParent || seats.find((s) => s.parent_id === null)?.id || null;
      const res = await fetch('/api/accountability/seats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chart_id: chart.id,
          title: formTitle.trim(),
          parent_id: parentId,
          people,
          roles,
          notes,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      setSaving(false);
      if (!res.ok) {
        setError(payload.error ?? 'Could not add the seat');
        return;
      }
      setSeats((list) => [...list, payload.seat]);
      closeForm();
    }
  };

  const promote = async () => {
    setPromoting(true);
    setError('');
    const res = await fetch('/api/accountability/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chart_id: chart.id }),
    });
    const payload = await res.json().catch(() => ({}));
    setPromoting(false);
    if (!res.ok) {
      setError(payload.error ?? 'Could not promote this chart');
      return;
    }
    window.location.href = '/dashboard/accountability?version=current';
  };

  /** PNG export: the React Flow recipe (getNodesBounds + getViewportForBounds). */
  const exportPng = async () => {
    const viewportEl = wrapper.current?.querySelector<HTMLElement>('.react-flow__viewport');
    if (!viewportEl || seats.length === 0) return;
    setExporting(true);
    setError('');
    try {
      const bounds = getNodesBounds(rf.getNodes());
      const width = Math.max(1024, Math.ceil(bounds.width) + 120);
      const height = Math.max(768, Math.ceil(bounds.height) + 120);
      const viewport = getViewportForBounds(bounds, width, height, 0.2, 2, 0.1);
      const dataUrl = await toPng(viewportEl, {
        backgroundColor: '#ffffff',
        pixelRatio: 2,
        width,
        height,
        style: {
          width: `${width}px`,
          height: `${height}px`,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
        },
      });
      const link = document.createElement('a');
      link.download = 'accountability-chart.png';
      link.href = dataUrl;
      link.click();
    } catch {
      setError('Could not export the chart as PNG');
    } finally {
      setExporting(false);
    }
  };

  const formOpen = adding || editingId !== null;

  // The edit form's Reports-to picker: every seat except the seat itself and
  // its descendants (what allowedParentIds leaves, links included); changes
  // re-parent through the same reparent PATCH as a drag. "Also reports to"
  // offers the same set minus the primary parent, saved as extra_parent_ids.
  const editSeat = editingId ? seats.find((s) => s.id === editingId) : undefined;
  const allowedParents = useMemo(
    () => (editSeat ? new Set(allowedParentIds(seats, editSeat.id, links)) : null),
    [seats, links, editSeat]
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span
          className={
            chart.status === 'current'
              ? 'badge bg-accent/15 text-accent'
              : 'badge bg-bg-elevated text-ink-secondary'
          }
        >
          {chart.status === 'current' ? 'Current' : 'Proposal'}
        </span>
        <span className="text-sm text-ink-secondary truncate">{chart.title}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button onClick={startAdd} className="btn-secondary text-sm">
            Add seat
          </button>
          <button
            onClick={() => void exportPng()}
            disabled={exporting || seats.length === 0}
            className="btn-secondary text-sm"
          >
            {exporting ? 'Exporting…' : 'Export PNG'}
          </button>
          {chart.status === 'proposal' && canPromote && (
            <button onClick={() => void promote()} disabled={promoting} className="btn-primary text-sm">
              {promoting ? 'Promoting…' : 'Promote to current'}
            </button>
          )}
        </div>
      </div>

      {formOpen && (
        <div className="mb-3 space-y-3 rounded-xl border border-line bg-bg-elevated p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            {editingId ? 'Edit seat' : 'Add seat'}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              className="input text-sm"
              placeholder="Seat title (e.g. Integrator)"
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              aria-label="Seat title"
            />
            <input
              className="input text-sm"
              placeholder="People, separated by ; (empty = open seat)"
              value={formPeople}
              onChange={(e) => setFormPeople(e.target.value)}
              aria-label="Seat people"
            />
          </div>
          {editSeat && allowedParents && (
            <select
              className="input text-sm"
              value={editSeat.parent_id ?? ''}
              onChange={(e) => {
                if (e.target.value) reparent(editSeat.id, e.target.value);
              }}
              aria-label="Reports to"
            >
              {editSeat.parent_id === null && <option value="">Top of chart</option>}
              {seatOptions(seats)
                .filter((o) => allowedParents.has(o.id))
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
            </select>
          )}
          {editSeat && allowedParents && (
            <div>
              <p className="text-xs font-medium text-ink-secondary">Also reports to</p>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {seatOptions(seats)
                  .filter((o) => allowedParents.has(o.id) && o.id !== editSeat.parent_id)
                  .map((o) => (
                    <label
                      key={o.id}
                      className="flex items-center gap-1.5 text-sm text-ink-secondary"
                    >
                      <input
                        type="checkbox"
                        className="accent-accent"
                        checked={links.some(
                          (l) => l.seat_id === editSeat.id && l.parent_id === o.id
                        )}
                        onChange={() => toggleExtraParent(editSeat.id, o.id)}
                      />
                      {o.label}
                    </label>
                  ))}
              </div>
            </div>
          )}
          {adding && seats.length > 0 && (
            <select
              className="input text-sm"
              value={formParent}
              onChange={(e) => setFormParent(e.target.value)}
              aria-label="Parent seat"
            >
              {seatOptions(seats).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <textarea
            className="input text-sm"
            rows={4}
            placeholder={'Roles, one per line (the first five are kept)'}
            value={formRoles}
            onChange={(e) => setFormRoles(e.target.value)}
            aria-label="Roles"
          />
          <textarea
            className="input text-sm"
            rows={2}
            placeholder="Notes (optional: extra roles, context)"
            value={formNotes}
            onChange={(e) => setFormNotes(e.target.value)}
            aria-label="Notes"
          />
          {error && <p className="text-xs text-state-danger">{error}</p>}
          <div className="flex gap-2">
            <button onClick={() => void saveForm()} disabled={saving} className="btn-primary text-sm">
              {saving ? 'Saving…' : editingId ? 'Save seat' : 'Add seat'}
            </button>
            <button onClick={closeForm} className="btn-secondary text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && !formOpen && <p className="mb-2 text-xs text-state-danger">{error}</p>}

      <div ref={wrapper} className="h-[640px] rounded-xl border border-line bg-bg-base">
        <ReactFlow<SeatFlowNode>
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypes}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.2}
          // The page keeps scrolling on wheel; zoom lives on the Controls.
          zoomOnScroll={false}
          preventScrolling={false}
          deleteKeyCode={null}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        Drag a card and drop it with the pointer over another card (it highlights) to re-parent it, or use
        "Reports to" in the edit form. The Visionary to Integrator connector is dotted; lighter connectors
        are extra reporting lines ("Also reports to" in the edit form); a "shared" tag marks a seat that
        needs to come back to one name.
      </p>
    </div>
  );
}
