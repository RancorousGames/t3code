/** Captures a file/folder drop before the browser releases DataTransfer entries. */
export interface DroppedSource { file: File; path: string }

async function visit(entry: FileSystemEntry, parent: string): Promise<DroppedSource[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    return [{ file, path: parent + entry.name }];
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    children.push(...batch);
  }
  return (await Promise.all(children.map(child => visit(child, parent + entry.name + "/")))).flat();
}

export function droppedSources(data: DataTransfer): Promise<DroppedSource[]> {
  // webkitGetAsEntry must be called synchronously during the drop event.
  const entries = [...data.items].filter(item => item.kind === "file")
    .map(item => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => !!entry);
  return entries.length
    ? Promise.all(entries.map(entry => visit(entry, ""))).then(groups => groups.flat())
    : Promise.resolve([...data.files].map(file => ({ file, path: file.webkitRelativePath || file.name })));
}
