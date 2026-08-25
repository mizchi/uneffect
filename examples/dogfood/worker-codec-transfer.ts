import type { BoundedDataView, FixedArrayBuffer } from "@mizchi/uneffect";

export function transferThenDecode(
  worker: Worker,
  buffer: FixedArrayBuffer<12>,
): BoundedDataView<12> {
  worker.postMessage(buffer, [buffer]);
  return new DataView(buffer) as unknown as BoundedDataView<12>;
}
