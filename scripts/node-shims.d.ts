// Minimal ambient declarations for the Node surface scripts/ touches.
//
// @types/node would be the usual answer, but every version line of it depends
// on undici-types, and the current release fails this project's
// `trust-policy=no-downgrade` check (an earlier undici-types had provenance
// attestation and the current one does not). Weakening that setting to gain
// types for two APIs is the wrong trade for a security tool, and hand-declaring
// them also documents exactly what the build scripts are allowed to reach for.
//
// Everything else these scripts use (URL, console) comes from
// @cloudflare/workers-types via the base tsconfig.

declare module 'node:fs' {
  /** Only the URL + utf8 overload is used, by scripts/validate-config.ts. */
  export function readFileSync(path: URL | string, encoding: 'utf8'): string;
}

declare const process: {
  exit(code?: number): never;
};

/** ES2022 declares ImportMeta but leaves `url` to the host lib. */
interface ImportMeta {
  readonly url: string;
}
