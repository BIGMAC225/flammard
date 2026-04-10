import type { Decision, ActionItem, DiscussionPoint, Attendee } from '../types';

export interface PDFInput {
  title: string;
  date: string;
  location?: string | null;
  attendees: Attendee[];
  summary: string | null;
  decisions: Decision[];
  actions: ActionItem[];
  discussion: DiscussionPoint[];
  hash: string;
  approvedBy: string;
  approvedAt: string;
  appName?: string;
}

const OUTCOME_COLORS: Record<string, [number, number, number]> = {
  approved: [34, 197, 94],
  rejected: [239, 68, 68],
  deferred: [245, 158, 11],
  noted: [123, 108, 246],
};

const STATUS_COLORS: Record<string, [number, number, number]> = {
  open: [96, 165, 250],
  completed: [34, 197, 94],
  overdue: [239, 68, 68],
};

/** Generates a PDF buffer server-side using jsPDF */
export async function generateMinutesPDF(input: PDFInput): Promise<Buffer> {
  // Dynamic import — avoids issues with SSR/canvas in serverless
  const { jsPDF } = await import('jspdf');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const marginX = 20;
  const pageW = 210;
  const contentW = pageW - marginX * 2;
  let y = marginX;

  const newPage = () => {
    doc.addPage();
    y = marginX;
  };

  const checkY = (need = 20) => {
    if (y > 287 - need) newPage();
  };

  const write = (
    text: string,
    size: number,
    weight: 'normal' | 'bold' = 'normal',
    color: [number, number, number] = [40, 40, 55],
    x = marginX
  ) => {
    doc.setFontSize(size);
    doc.setFont('helvetica', weight);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(text, contentW - (x - marginX));
    doc.text(lines, x, y);
    y += lines.length * size * 0.37 + 1.5;
    return lines.length;
  };

  const sectionHeader = (label: string) => {
    checkY(16);
    y += 4;
    doc.setFillColor(244, 244, 248);
    doc.roundedRect(marginX, y - 5, contentW, 9, 1.5, 1.5, 'F');
    write(label, 8, 'bold', [80, 80, 110]);
    y += 1;
  };

  // ── Header bar ──────────────────────────────────────────
  doc.setFillColor(8, 8, 12);
  doc.rect(0, 0, pageW, 42, 'F');

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(240, 240, 245);
  const titleLines = doc.splitTextToSize(input.title, contentW);
  doc.text(titleLines, marginX, 16);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(138, 139, 154);
  const subtitle = [
    input.date,
    input.location,
    `${input.appName ?? 'Flammard'} · Approved Record`,
  ]
    .filter(Boolean)
    .join('  ·  ');
  doc.text(subtitle, marginX, 16 + titleLines.length * 6 + 2);

  y = 52;

  // ── Attendees ────────────────────────────────────────────
  if (input.attendees.length > 0) {
    sectionHeader('ATTENDEES');
    const list = input.attendees
      .map((a) => (a.email ? `${a.name} <${a.email}>` : a.name))
      .join('   ·   ');
    write(list, 8.5, 'normal', [80, 80, 100]);
  }

  // ── Summary ──────────────────────────────────────────────
  if (input.summary) {
    checkY(30);
    sectionHeader('SUMMARY');
    write(input.summary, 9.5, 'normal', [40, 40, 55]);
  }

  // ── Decisions ────────────────────────────────────────────
  if (input.decisions.length > 0) {
    checkY(30);
    sectionHeader('DECISIONS');
    for (const d of input.decisions) {
      checkY(18);
      const dotColor = OUTCOME_COLORS[d.outcome] ?? [123, 108, 246];
      doc.setFillColor(...dotColor);
      doc.circle(marginX + 2.5, y - 1.5, 2, 'F');

      const lines = doc.splitTextToSize(d.text, contentW - 9);
      doc.setFontSize(9.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(40, 40, 55);
      doc.text(lines, marginX + 7, y);
      y += lines.length * 3.8 + 1;

      const meta: string[] = [d.outcome.toUpperCase()];
      if (d.mover) meta.push(`Proposed by: ${d.mover}`);
      write(meta.join('   ·   '), 7.5, 'normal', [120, 120, 140], marginX + 7);
      y += 3;
    }
  }

  // ── Action Items ─────────────────────────────────────────
  if (input.actions.length > 0) {
    checkY(30);
    sectionHeader('ACTION ITEMS');
    for (const a of input.actions) {
      checkY(18);
      const dotColor = STATUS_COLORS[a.status] ?? [96, 165, 250];
      doc.setFillColor(...dotColor);
      doc.circle(marginX + 2.5, y - 1.5, 2, 'F');

      const lines = doc.splitTextToSize(a.text, contentW - 9);
      doc.setFontSize(9.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(40, 40, 55);
      doc.text(lines, marginX + 7, y);
      y += lines.length * 3.8 + 1;

      const meta: string[] = [];
      if (a.owner) meta.push(`Owner: ${a.owner}`);
      if (a.due_date) meta.push(`Due: ${a.due_date}`);
      if (meta.length) write(meta.join('   ·   '), 7.5, 'normal', [120, 120, 140], marginX + 7);
      y += 3;
    }
  }

  // ── Discussion ───────────────────────────────────────────
  if (input.discussion.length > 0) {
    checkY(30);
    sectionHeader('DISCUSSION');
    for (const d of input.discussion) {
      checkY(20);
      write(d.topic, 9.5, 'bold', [60, 60, 80]);
      write(d.notes, 9, 'normal', [80, 80, 100]);
      y += 4;
    }
  }

  // ── Seal footer ──────────────────────────────────────────
  checkY(38);
  y += 8;
  doc.setDrawColor(210, 210, 220);
  doc.setLineWidth(0.25);
  doc.line(marginX, y, pageW - marginX, y);
  y += 6;

  write('CRYPTOGRAPHIC SEAL', 7.5, 'bold', [100, 100, 130]);
  write(`SHA-256: ${input.hash}`, 7, 'normal', [120, 120, 150]);
  write(
    `Approved by: ${input.approvedBy}   ·   ${new Date(input.approvedAt).toUTCString()}`,
    7.5,
    'normal',
    [100, 100, 130]
  );

  const arrayBuf = doc.output('arraybuffer');
  return Buffer.from(arrayBuf);
}
