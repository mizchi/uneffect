import type { BoundedDataView, FixedArrayBuffer, Nat } from "@mizchi/uneffect";

export interface DnsHeader {
  id: number;
  flags: number;
  questionCount: number;
  answerCount: number;
  authorityCount: number;
  additionalCount: number;
}

export function createDnsHeaderView(buffer: FixedArrayBuffer<12>): BoundedDataView<12> {
  return new DataView(buffer);
}

export function decodeDnsHeader(view: BoundedDataView<12>): DnsHeader {
  const cursor = view;
  return {
    id: cursor.getUint16(0, false),
    flags: cursor.getUint16(2, false),
    questionCount: cursor.getUint16(4, false),
    answerCount: cursor.getUint16(6, false),
    authorityCount: cursor.getUint16(8, false),
    additionalCount: cursor.getUint16(10, false),
  };
}

/* uneffect:contract requires id <= 65535 && flags <= 65535 && questionCount <= 65535 && answerCount <= 65535 && authorityCount <= 65535 && additionalCount <= 65535 */
export function encodeDnsHeader(
  view: BoundedDataView<12>,
  id: Nat,
  flags: Nat,
  questionCount: Nat,
  answerCount: Nat,
  authorityCount: Nat,
  additionalCount: Nat,
): void {
  const cursor = view;
  cursor.setUint16(0, id, false);
  cursor.setUint16(2, flags, false);
  cursor.setUint16(4, questionCount, false);
  cursor.setUint16(6, answerCount, false);
  cursor.setUint16(8, authorityCount, false);
  cursor.setUint16(10, additionalCount, false);
}
