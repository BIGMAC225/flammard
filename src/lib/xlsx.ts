import JSZip from 'jszip';

// Minimal XLSX reader for the Ninety importer. Browser-only in the app (it
// uses the global DOMParser), but pure given a DOMParser, so a script can
// pass one in. Cells come back as raw strings: shared and inline strings as
// text, numbers (including Excel date serials) as their digits. Styles and
// number formats are not read; dates are recognised by column name.
//
// Ninety writes some workbooks with an `x:` namespace prefix (<x:row>,
// <x:c>, <x:t>), so elements are always selected by local name.

export interface Sheet {
  name: string;
  /** rows[i] is spreadsheet row i + 1; missing rows are empty arrays. */
  rows: string[][];
}
export interface Workbook {
  sheets: Sheet[];
}

export interface XmlParser {
  parseFromString(source: string, mimeType: 'application/xml' | 'text/xml'): Document;
}

// Elements by local name, whatever the prefix
const byLocal = (root: Document | Element, name: string): Element[] =>
  Array.from(root.getElementsByTagNameNS('*', name) as ArrayLike<Element>);

const childrenByLocal = (el: Element, name: string): Element[] => {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).localName === name) out.push(n as Element);
  }
  return out;
};

/** Text of every descendant <t>, skipping phonetic runs (<rPh>). */
function richText(el: Element): string {
  let out = '';
  for (const t of byLocal(el, 't')) {
    let skip = false;
    for (let p = t.parentNode; p && p !== el; p = p.parentNode) {
      if ((p as Element).localName === 'rPh') {
        skip = true;
        break;
      }
    }
    if (!skip) out += t.textContent ?? '';
  }
  return out;
}

/** 'A' → 0, 'Z' → 25, 'AA' → 26, from a cell reference such as 'AB12'. */
export function columnIndex(ref: string): number | null {
  const m = /^([A-Z]+)/i.exec(ref);
  if (!m) return null;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** The r:id attribute of a <sheet>, found by local name whatever its prefix. */
function relId(el: Element): string | null {
  for (const a of Array.from(el.attributes as ArrayLike<Attr>)) {
    if ((a.localName === 'id' && a.name !== 'id') || a.name === 'r:id') return a.value;
  }
  return null;
}

function normalizeTarget(target: string): string {
  let t = target.replace(/\\/g, '/');
  if (t.startsWith('/')) return t.slice(1);
  while (t.startsWith('./')) t = t.slice(2);
  if (t.startsWith('../')) return t.slice(3); // relative to xl/ → package root
  return t.startsWith('xl/') ? t : `xl/${t}`;
}

export async function readWorkbook(data: ArrayBuffer | Uint8Array, parser?: XmlParser): Promise<Workbook> {
  const xml: XmlParser = parser ?? (new DOMParser() as unknown as XmlParser);
  const zip = await JSZip.loadAsync(data);
  const read = async (path: string): Promise<Document | null> => {
    const f = zip.file(path);
    if (!f) return null;
    // Some Ninety parts start with a byte-order mark, which XML parsers reject before <?xml
    const source = (await f.async('string')).replace(/^﻿/, '');
    return xml.parseFromString(source, 'application/xml');
  };

  const workbook = await read('xl/workbook.xml');
  if (!workbook) throw new Error('Not an Excel workbook (xl/workbook.xml is missing)');
  const rels = await read('xl/_rels/workbook.xml.rels');
  const targets = new Map<string, string>();
  if (rels) {
    for (const r of byLocal(rels, 'Relationship')) {
      const id = r.getAttribute('Id');
      const target = r.getAttribute('Target');
      if (id && target) targets.set(id, normalizeTarget(target));
    }
  }

  const sharedDoc = await read('xl/sharedStrings.xml');
  const shared = sharedDoc ? byLocal(sharedDoc, 'si').map(richText) : [];

  const sheets: Sheet[] = [];
  const sheetEls = byLocal(workbook, 'sheet');
  for (let i = 0; i < sheetEls.length; i++) {
    const el = sheetEls[i];
    const name = el.getAttribute('name') ?? `Sheet${i + 1}`;
    const rid = relId(el);
    const path = (rid && targets.get(rid)) || `xl/worksheets/sheet${i + 1}.xml`;
    const doc = await read(path);
    sheets.push({ name, rows: doc ? readRows(doc, shared) : [] });
  }
  return { sheets };
}

function cellValue(c: Element, shared: string[]): string {
  const type = c.getAttribute('t');
  const v = () => {
    const el = childrenByLocal(c, 'v')[0] ?? byLocal(c, 'v')[0];
    return el?.textContent ?? '';
  };
  switch (type) {
    case 's': {
      const i = Number(v());
      return Number.isInteger(i) ? (shared[i] ?? '') : '';
    }
    case 'inlineStr': {
      const is = byLocal(c, 'is')[0];
      return is ? richText(is) : '';
    }
    case 'e':
      return '';
    default: // 'str', 'b', 'n', 'd' or none
      return v();
  }
}

function readRows(doc: Document, shared: string[]): string[][] {
  const rows: string[][] = [];
  let prevRow = -1;
  for (const rowEl of byLocal(doc, 'row')) {
    const r = Number(rowEl.getAttribute('r'));
    const ri = Number.isInteger(r) && r >= 1 ? r - 1 : prevRow + 1;
    prevRow = ri;
    const cells: string[] = [];
    let prevCol = -1;
    for (const c of childrenByLocal(rowEl, 'c')) {
      const ref = c.getAttribute('r');
      const ci = (ref ? columnIndex(ref) : null) ?? prevCol + 1;
      prevCol = ci;
      while (cells.length < ci) cells.push('');
      cells[ci] = cellValue(c, shared);
    }
    while (rows.length < ri) rows.push([]);
    rows[ri] = cells;
  }
  return rows;
}
