const warmCache = process.argv.includes("--warm-cache");

export let cacheState = "cold";
if (warmCache) cacheState = await Promise.resolve("warm");
