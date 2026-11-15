import { Container } from "@cloudflare/containers";
import { env } from "cloudflare:workers";

export class ExcalidrawContainer extends Container {
  defaultPort = 3002;
  sleepAfter = "15m";

  // Non-secret values live in `vars` in wrangler.jsonc and are already on `env`.
  // Secrets below must be set once via `wrangler secret put <NAME>`.
  envVars = {
    STORAGE_TYPE: env.STORAGE_TYPE,
    S3_BUCKET_NAME: env.S3_BUCKET_NAME,
    AWS_REGION: env.AWS_REGION,
    AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
    AWS_ENDPOINT_URL: env.AWS_ENDPOINT_URL,
    JWT_SECRET: env.JWT_SECRET,
    CF_ACCESS_TEAM_DOMAIN: env.CF_ACCESS_TEAM_DOMAIN,
    CF_ACCESS_AUD: env.CF_ACCESS_AUD,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const container = env.EXCALIDRAW_CONTAINER.getByName("default");
    return await container.fetch(request);
  },
};
