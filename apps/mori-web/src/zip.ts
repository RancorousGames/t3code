// Minimal zip reader for DOCX and XLSX (both are zip packages). Browsers provide inflate
// through DecompressionStream, so no third-party archive library is needed.
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
