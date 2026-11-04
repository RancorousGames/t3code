// Minimal zip reader and writer for DOCX and XLSX (both are zip packages). Browsers provide inflate
// through DecompressionStream, so no third-party archive library is needed. Written entries are stored
// uncompressed, which every Office reader accepts.
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_XML_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_XML_BYTES = 96 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const relevantXml = (name: string) => name === "word/document.xml" ||
  name === "xl/workbook.xml" || name === "xl/_rels/workbook.xml.rels" ||
  name === "xl/sharedStrings.xml" || /^xl\/worksheets\/[\w-]+\.xml$/.test(name);

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_XML_ENTRY_BYTES) throw new Error("Office XML entry exceeds the 32 MiB safety limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.byteLength; }
  return result;
}

/** Reads every file in the archive into memory, keyed by its path inside the package. */
export async function unzip(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Office file exceeds the 64 MiB import limit.");
  const view = new DataView(buffer);
  const data = new Uint8Array(buffer);

  // The directory sits at the end of the file, after an optional comment of up to 64 KB.
  let directory = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY) {
      directory = i;
      break;
    }
  }
  if (directory < 0) throw new Error("Not a valid Office file: the zip directory is missing.");

  const count = view.getUint16(directory + 10, true);
  if (count > MAX_ZIP_ENTRIES) throw new Error("Office file contains too many archive entries.");
  let totalUncompressed = 0;
  let position = view.getUint32(directory + 16, true);
  const files = new Map<string, Uint8Array>();

  for (let n = 0; n < count; n++) {
    if (view.getUint32(position, true) !== CENTRAL_FILE_HEADER) throw new Error("Corrupt zip directory.");
    const method = view.getUint16(position + 10, true);
    const size = view.getUint32(position + 20, true);
    const uncompressedSize = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const localOffset = view.getUint32(position + 42, true);
    const name = new TextDecoder().decode(data.subarray(position + 46, position + 46 + nameLength));
    position += 46 + nameLength + extraLength + commentLength;
    // Office pictures, fonts, thumbnails and other media are not needed for text extraction.
    if (!relevantXml(name)) continue;
    if (uncompressedSize > MAX_XML_ENTRY_BYTES) throw new Error(`Office XML entry too large: ${name}`);
    if (localOffset + 30 > buffer.byteLength) throw new Error(`Corrupt zip entry bounds: ${name}`);
    if (view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER) throw new Error(`Corrupt zip entry: ${name}`);
    // The local header repeats the name and extra field with its own lengths, which can differ from the directory's.
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (start + size > buffer.byteLength) throw new Error(`Corrupt zip payload: ${name}`);
    const chunk = data.subarray(start, start + size);
    const content = method === STORED ? chunk.slice() : method === DEFLATED ? await inflateRaw(chunk) : null;
    if (!content) throw new Error(`Unsupported compression in ${name}.`);
    totalUncompressed += content.byteLength;
    if (totalUncompressed > MAX_TOTAL_XML_BYTES) throw new Error("Office file XML exceeds the 96 MiB safety limit.");
    files.set(name, content);
  }
  return files;
}

// ---------------------------------------------------------------- writing

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

interface ZipEntry { name: Uint8Array; method: number; crc: number; size: number; rawSize: number; data: Uint8Array; time: number; date: number }

/** Writes entries as a zip. Entries with method 0 are stored; others carry their already-compressed data. */
function writeZip(entries: ZipEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL_FILE_HEADER, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, e.method, true);
    local.setUint16(10, e.time, true);
    local.setUint16(12, e.date, true);
    local.setUint32(14, e.crc, true);
    local.setUint32(18, e.size, true);
    local.setUint32(22, e.rawSize, true);
    local.setUint16(26, e.name.length, true);
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, CENTRAL_FILE_HEADER, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 20, true);
    head.setUint16(8, 0x0800, true);
    head.setUint16(10, e.method, true);
    head.setUint16(12, e.time, true);
    head.setUint16(14, e.date, true);
    head.setUint32(16, e.crc, true);
    head.setUint32(20, e.size, true);
    head.setUint32(24, e.rawSize, true);
    head.setUint16(28, e.name.length, true);
    head.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), e.name, e.data);
    central.push(new Uint8Array(head.buffer), e.name);
    offset += 30 + e.name.length + e.data.length;
  }
  const centralSize = central.reduce((n, part) => n + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, part) => n + part.length, 0));
  let cursor = 0;
  for (const part of all) { out.set(part, cursor); cursor += part.length; }
  return out;
}

const dosNow = () => {
  const d = new Date();
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
};
const stored = (name: string, data: Uint8Array): ZipEntry => ({
  name: new TextEncoder().encode(name), method: STORED, crc: crc32(data), size: data.length, rawSize: data.length, data, ...dosNow(),
});

/** Copies an Office package, replacing the given entries (stored uncompressed). Everything else is copied byte for byte. */
export function replaceInZip(buffer: ArrayBuffer | Uint8Array, replacements: Map<string, Uint8Array>): Uint8Array {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let directory = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY) { directory = i; break; }
  }
  if (directory < 0) throw new Error("Not a valid Office file: the zip directory is missing.");
  const entries: ZipEntry[] = [];
  let position = view.getUint32(directory + 16, true);
  for (let n = view.getUint16(directory + 10, true); n > 0; n--) {
    const nameLength = view.getUint16(position + 28, true);
    const nameBytes = data.slice(position + 46, position + 46 + nameLength);
    const name = new TextDecoder().decode(nameBytes);
    const localOffset = view.getUint32(position + 42, true);
    const size = view.getUint32(position + 20, true);
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const replacement = replacements.get(name);
    entries.push(replacement ? stored(name, replacement) : {
      name: nameBytes, method: view.getUint16(position + 10, true), crc: view.getUint32(position + 16, true),
      size, rawSize: view.getUint32(position + 24, true), data: data.subarray(start, start + size),
      time: view.getUint16(position + 12, true), date: view.getUint16(position + 14, true),
    });
    position += 46 + nameLength + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
  }
  return writeZip(entries);
}

/** A new zip of the given files (stored uncompressed), e.g. several exported files in their folders. */
export const zipFiles = (files: { path: string; data: Uint8Array }[]) => writeZip(files.map(f => stored(f.path, f.data)));
