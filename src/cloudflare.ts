// Cloudflare deployment module. Flue discovers this and includes its exports in
// the generated Worker. The container-backed sandbox Durable Object is
// application-owned, so we export its class and declare its binding/container/
// migration in wrangler.jsonc (Flue owns the FLUE_* generated bindings).
export { Sandbox } from '@cloudflare/sandbox';
