export interface ProjectByteCoordinates {
  readonly fileNames: readonly string[];
  base(fileName: string): number;
  offset(fileName: string, utf16Offset: number): number;
}

export function createProjectByteCoordinates(files: Readonly<Record<string, string>>): ProjectByteCoordinates {
  const fileNames = Object.keys(files).sort((left, right) => left.localeCompare(right));
  const bases = new Map<string, number>();
  let next = 0;
  for (const fileName of fileNames) {
    bases.set(fileName, next);
    next += Buffer.byteLength(files[fileName]!) + 1;
  }
  return {
    fileNames,
    base(fileName) {
      const value = bases.get(fileName);
      if (value === undefined) throw new Error(`unknown project source file: ${fileName}`);
      return value;
    },
    offset(fileName, utf16Offset) {
      const text = files[fileName];
      if (text === undefined) throw new Error(`unknown project source file: ${fileName}`);
      return this.base(fileName) + Buffer.byteLength(text.slice(0, utf16Offset));
    },
  };
}

export function projectFunctionDisplayName(
  fileName: string,
  localName: string,
  counts: ReadonlyMap<string, number>,
): string {
  return (counts.get(localName) ?? 0) > 1 ? `${fileName}::${localName}` : localName;
}
