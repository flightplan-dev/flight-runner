import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/setup/index.ts', 'src/setup/wait.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // Keep packages with native modules or dynamic requires external
  external: [
    // Native modules
    '@mariozechner/clipboard',
    // Packages with dynamic require() that break ESM bundling
    'google-auth-library',
    'gcp-metadata', 
    'gtoken',
  ],
  // Add shim for any remaining dynamic require calls
  banner: {
    js: `import { createRequire } from 'module';const require = createRequire(import.meta.url);`,
  },
})
