import JSZip from 'jszip';

// Plain text out of the files people keep plans in. PowerPoint and Word are
// zips of XML; everything readable is in <a:t> / <w:t> nodes.

const MAX_INFLATED = 20 * 1024 * 1024; // a 15 MB upload may not inflate past this
const MAX_SLIDES = 300;
const MAX_CHARS = 120_000;

const decode = (s: string) =>
  s
    .replace(/&#(x?)([0-9a-f]+);/gi, (m, x, n) => {
      const cp = parseInt(n, x ? 16 : 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

function xmlText(xml: string, tag: 'a:t' | 'w:t', paragraph: RegExp): string {
  // One line per paragraph, runs within a paragraph joined
  const run = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g');
  return xml
    .split(paragraph)
    .map((para) => Array.from(para.matchAll(run), (m) => decode(m[1])).join(''))
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

// Inflate with a byte budget. The declared size is a fast pre-check, but a
// crafted zip can lie about it, so the bytes are counted as they stream and
// the read is abandoned the moment the budget is exceeded.
const TOO_BIG = 'That file is larger than expected once unpacked — paste the text instead';

function readEntry(zip: JSZip, name: string, budget: { left: number }): Promise<string | null> {
  const entry = zip.file(name);
  if (!entry) return Promise.resolve(null);
  const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  if (declared > budget.left) return Promise.reject(new Error(TOO_BIG));

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    // internalStream is public in JSZip 3.x but missing from its typings
    const stream = (entry as unknown as { internalStream: (t: 'uint8array') => any }).internalStream('uint8array');
    stream
      .on('data', (chunk: Uint8Array) => {
        size += chunk.length;
        if (size > budget.left) {
          stream.pause();
          reject(new Error(TOO_BIG));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', reject)
      .on('end', () => {
        budget.left -= size;
        const all = new Uint8Array(size);
        let offset = 0;
        for (const c of chunks) {
          all.set(c, offset);
          offset += c.length;
        }
        resolve(new TextDecoder().decode(all));
      })
      .resume();
  });
}

/** Slide files in presentation order (presentation.xml → rels), else by number. */
function slideOrder(zip: JSZip, presentationXml: string | null, relsXml: string | null): string[] {
  const byNumber = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  if (!presentationXml || !relsXml) return byNumber;

  const rels = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1];
    const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) rels.set(id, `ppt/${target.replace(/^\/?ppt\//, '').replace(/^\.\.\//, '')}`);
  }
  const ordered = Array.from(presentationXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g), (m) => rels.get(m[1]))
    .filter((f): f is string => !!f && !!zip.file(f));
  return ordered.length ? ordered : byNumber;
}

export async function pptxToText(data: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const budget = { left: MAX_INFLATED };
  const slides = slideOrder(
    zip,
    await readEntry(zip, 'ppt/presentation.xml', budget),
    await readEntry(zip, 'ppt/_rels/presentation.xml.rels', budget)
  ).slice(0, MAX_SLIDES);

  const parts: string[] = [];
  let chars = 0;
  for (const [i, file] of slides.entries()) {
    const xml = await readEntry(zip, file, budget);
    const text = xml ? xmlText(xml, 'a:t', /<\/a:p>/) : '';
    if (text) {
      parts.push(`--- Slide ${i + 1} ---\n${text}`);
      chars += text.length;
      if (chars > MAX_CHARS) break;
    }
  }
  return parts.join('\n\n');
}

export async function docxToText(data: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const xml = await readEntry(zip, 'word/document.xml', { left: MAX_INFLATED });
  return xml ? xmlText(xml, 'w:t', /<\/w:p>/) : '';
}

/** Text from an uploaded plan file, by extension. */
export async function fileToText(name: string, data: ArrayBuffer): Promise<string> {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pptx') return pptxToText(data);
  if (ext === 'docx') return docxToText(data);
  if (['txt', 'md', 'csv', 'tsv'].includes(ext)) return new TextDecoder().decode(data);
  throw new Error('Upload a .pptx, .docx, .txt, .md or .csv — or paste the plan as text');
}
