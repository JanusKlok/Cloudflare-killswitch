/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Vite's ?raw suffix inlines a file's text at transform time, which is how the
// setup-script tests read shell sources inside the Workers pool (no node:fs).
declare module '*?raw' {
  const content: string;
  export default content;
}
