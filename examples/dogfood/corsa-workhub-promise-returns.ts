// Derived from Workhub invoice and GitHub clients at
// revision 089c385082644d30f4fceef88e41236b624a6b29.
export function download(response: Response): Promise<ArrayBuffer> {
  return response.arrayBuffer();
}

export function decode<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}
