/** Workhub-shaped CLI entry: launch is synchronous; the async body is not module TLA. */
async function main(): Promise<void> {
  await Promise.resolve();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
