// Augment the global Cloudflare.Env so that `env` from `cloudflare:workers`
// carries our Worker's binding types.
declare namespace Cloudflare {
  interface Env {
    KILL_SWITCH_STATE: KVNamespace;
    CLOUDFLARE_API_TOKEN: string;
    RECOVERY_SECRET: string;
    CLOUDFLARE_ACCOUNT_ID: string;
    CLOUDFLARE_ZONE_ID: string;
    SEND_EMAIL?: SendEmail;
    EMAIL_FROM?: string;
    EMAIL_TO?: string;
  }
}
