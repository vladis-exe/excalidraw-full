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
    OIDC_ISSUER_URL: env.OIDC_ISSUER_URL,
    OIDC_CLIENT_ID: env.OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET: env.OIDC_CLIENT_SECRET,
    OIDC_REDIRECT_URL: env.OIDC_REDIRECT_URL,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const container = env.EXCALIDRAW_CONTAINER.getByName("default");
    return await container.fetch(request);
  },
};
