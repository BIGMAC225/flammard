import JSZip from 'jszip';

// Plain text out of the files people keep plans in. PowerPoint and Word are
// zips of XML; everything readable is in <a:t> / <w:t> nodes.

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

function xmlText(xml: string, tag: 'a:t' | 'w:t', paragraph: RegExp): string {
  // One line per paragraph, runs within a paragraph joined
  return xml
    .split(paragraph)
    .map((para) => Array.from(para.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'g')), (m) => decode(m[1])).join(''))
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

export async function pptxToText(data: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const parts: string[] = [];
  for (const [i, file] of slides.entries()) {
    const xml = await zip.file(file)!.async('string');
    const text = xmlText(xml, 'a:t', /<\/a:p>/);
    if (text) parts.push(`--- Slide ${i + 1} ---\n${text}`);
  }
  return parts.join('\n\n');
}

export async function docxToText(data: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file('word/document.xml')?.async('string');
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
