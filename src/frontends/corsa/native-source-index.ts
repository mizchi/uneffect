/**
 * Small, version-checked index into the native 7.0.2 binary AST (protocol 5).
 * Layout: microsoft/typescript-go, typescript/v7.0.2,
 * _packages/native-preview/src/api/node/{protocol,node}.ts.
 * This indexes native handles; Oxc continues to own syntax interpretation.
 */
export interface NativeSourceNode {
  readonly handle: string;
  readonly kind: number;
  readonly span: { start: number; end: number };
}
export interface NativeSourceIndex {
  readonly text: string;
  readonly fileName: string;
  readonly path: string;
  find(kind: number, span: { start: number; end: number }): NativeSourceNode | null;
  node(handle: string): NativeSourceNode;
}

/** Native protocol-5 kinds, not JavaScript TypeScript compiler enum values. */
export const nativeCallableKinds = {
  CallExpression: 214, NewExpression: 215, FunctionExpression: 219,
  ArrowFunctionExpression: 220, FunctionDeclaration: 263, TSDeclareFunction: 263,
} as const;

export function parseNativeNodeHandle(handle: string): { index: number; kind: number; path: string } {
  const match = /^([1-9]\d*)\.(\d+)\.(.+)$/u.exec(handle);
  if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))) throw new Error("invalid native node handle");
  return { index: Number(match[1]), kind: Number(match[2]), path: match[3]! };
}

function skipTrivia(text: string, start: number, end: number): number {
  let position = start;
  while (position < end) {
    if (/\s/u.test(text[position]!)) { position++; continue; }
    if (text.startsWith("//", position) || position === 0 && text.startsWith("#!")) {
      while (position < end && !/[\r\n\u2028\u2029]/u.test(text[position]!)) position++;
      continue;
    }
    if (text.startsWith("/*", position)) {
      const close = text.indexOf("*/", position + 2);
      if (close < 0 || close + 2 > end) throw new Error("invalid native node trivia");
      position = close + 2;
      continue;
    }
    break;
  }
  return position;
}

export function decodeNativeSourceIndex(bytes: Uint8Array): NativeSourceIndex {
  const invalid = (detail: string): never => { throw new Error(`invalid native source index: ${detail}`); };
  if (bytes.length < 44) invalid("truncated header");
  if (bytes[3] !== 5) invalid(`unsupported binary protocol ${bytes[3]}; expected 5`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsets = [24, 28, 32, 36, 40].map(offset => view.getUint32(offset, true));
  if (offsets.some((offset, index) => offset < (index === 0 ? 44 : offsets[index - 1]!) || offset > bytes.length)) invalid("section bounds");
  const [stringOffsets, stringData, extendedData, structuredData, nodes] = offsets as [number, number, number, number, number];
  if ((stringData - stringOffsets) % 4 !== 0 || (bytes.length - nodes) % 28 !== 0 || bytes.length - nodes < 56) invalid("table bounds");
  const count = (bytes.length - nodes) / 28;
  const readExtended = (offset: number): number => {
    if (offset < extendedData || offset + 4 > structuredData) invalid("extended data bounds");
    return view.getUint32(offset, true);
  };
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const string = (index: number): string => {
    const offset = stringOffsets + index * 4;
    if (offset < stringOffsets || offset + 8 > stringData) invalid("string index bounds");
    const start = view.getUint32(offset, true), end = view.getUint32(offset + 4, true);
    if (end < start || stringData + end > extendedData) invalid("string data bounds");
    return decoder.decode(bytes.subarray(stringData + start, stringData + end));
  };
  const root = nodes + 28, data = view.getUint32(root + 20, true);
  if (view.getUint32(root, true) !== 307 || (data >>> 30) !== 2) invalid("missing SourceFile root");
  const rootExtended = extendedData + (data & 0x00ff_ffff);
  const text = string(readExtended(rootExtended));
  const fileName = string(readExtended(rootExtended + 4)), path = string(readExtended(rootExtended + 8));
  if (!fileName || !path) invalid("missing SourceFile path");
  const readNode = (index: number): NativeSourceNode => {
    if (!Number.isSafeInteger(index) || index < 1 || index >= count) invalid("node index bounds");
    const offset = nodes + index * 28, kind = view.getUint32(offset, true);
    const pos = view.getInt32(offset + 4, true), end = view.getInt32(offset + 8, true);
    if (kind === 0xffff_ffff || pos < 0 || end < pos || end > text.length) invalid("node range");
    return { handle: `${index}.${kind}.${path}`, kind, span: { start: skipTrivia(text, pos, end), end } };
  };
  return {
    text, fileName, path,
    find(kind, span) {
      let found: NativeSourceNode | null = null;
      for (let index = 2; index < count; index++) {
        const offset = nodes + index * 28;
        if (view.getUint32(offset, true) !== kind || view.getInt32(offset + 8, true) !== span.end) continue;
        const node = readNode(index);
        if (node.span.start !== span.start) continue;
        if (found) invalid("ambiguous source range");
        found = node;
      }
      return found;
    },
    node(handle) {
      const parsed = parseNativeNodeHandle(handle);
      if (parsed.path !== path) invalid("node belongs to another source file");
      const node = readNode(parsed.index);
      if (node.kind !== parsed.kind) invalid("node kind mismatch");
      return node;
    },
  };
}
