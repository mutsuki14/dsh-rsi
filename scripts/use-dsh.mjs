#!/usr/bin/env node
// Rewrites devDependencies to one supported dsh release line for the CI matrix:
//   node scripts/use-dsh.mjs 0.2.0-rc.2   (what `npx @deepseek-ai/dsh` installs)
//   node scripts/use-dsh.mjs 0.2.1-alpha.2
// Then run `pnpm install --no-frozen-lockfile`. The committed lockfile stays on the alpha line.
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
const lines = {
  '0.2.0-rc.2': { cordis: '4.0.4', missing: ['@deepseek-ai/dsh-working-directory'] },
  '0.2.1-alpha.2': { cordis: '4.0.5-alpha.1', missing: [] },
}
const line = lines[version]
if (!line) {
  console.error(`usage: use-dsh.mjs <${Object.keys(lines).join('|')}>`)
  process.exit(2)
}
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
for (const name of Object.keys(manifest.devDependencies)) {
  if (line.missing.includes(name)) delete manifest.devDependencies[name]
  else if (name === '@deepseek-ai/cordis') manifest.devDependencies[name] = line.cordis
  else if (name.startsWith('@deepseek-ai/dsh-')) manifest.devDependencies[name] = version
}
writeFileSync('package.json', `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`devDependencies now target dsh ${version}`)
