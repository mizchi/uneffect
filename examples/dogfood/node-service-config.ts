export interface ServiceConfig {
  region: string;
  datadogApiKey?: string;
}

/* uneffect:capability effect Env<"AWS_REGION" | "DD_API_KEY"> */
export function loadServiceConfig(): ServiceConfig {
  return {
    region: process.env.AWS_REGION ?? "us-east-1",
    datadogApiKey: process.env["DD_API_KEY"],
  };
}
