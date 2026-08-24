// Throwing is an effect: an uncaught throw needs Throw<TypeError> in the declaration.
/* uneffect: effect Console */
export function parsePort(value: string) {
  const port = Number(value);
  if (Number.isNaN(port)) {
    throw new TypeError("port must be numeric");
  }
  console.log(port);
  return port;
}
