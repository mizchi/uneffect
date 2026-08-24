// `using` requires the disposal protocol; this resource never releases anything.
export function open() {
  return { close() {} };
}

export function withResource() {
  using resource = open();
  return resource;
}
