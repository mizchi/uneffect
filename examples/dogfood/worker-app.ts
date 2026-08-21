export function dispatch(worker: Worker) {
  const buffer = new ArrayBuffer(1024);
  new Uint8Array(buffer).fill(1);
  worker.postMessage(buffer, [buffer]);
}
