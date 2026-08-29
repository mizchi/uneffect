// Derived from Workhub packages/x-monitor/src/x-client.ts at
// revision 089c385082644d30f4fceef88e41236b624a6b29.
export async function readErrorBody(response: Response): Promise<string> {
  if (!response.ok) {
    return await response.text();
  }
  return "";
}
