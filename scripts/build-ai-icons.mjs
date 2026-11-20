/**
 * Builds assets/ai-stack.svg: a row of AI/data tool icons drawn with the same tile
 * geometry as skillicons.dev (256px tile, rx 60, #242938, 300px step), so both rows
 * line up in the README. skillicons.dev has no icons for these tools.
 *
 * Icons come from Simple Icons (CC0), pinned to an exact version.
 * Run manually when the list changes:  node scripts/build-ai-icons.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'

const SIMPLE_ICONS_VERSION = '16.38.0'

// [slug, title, color] — color overrides the brand color when it has no contrast on the tile.
const ICONS = [
  ['claude', 'Claude', '#D97757'],
  ['modelcontextprotocol', 'Model Context Protocol', '#FFFFFF'],
  ['langgraph', 'LangGraph', '#7FC8FF'],
  ['crewai', 'CrewAI', '#FF5A50'],
  ['googlebigquery', 'BigQuery', '#669DF6'],
  ['apacheairflow', 'Apache Airflow', '#017CEE'],
]

const TILE = 256
const STEP = 300
const ICON = 150 // icon size inside the tile
const SCALE = ICON / 24 // Simple Icons use a 24x24 viewBox
const OFFSET = (TILE - ICON) / 2

async function iconPaths(slug) {
  const url = `https://cdn.jsdelivr.net/npm/simple-icons@${SIMPLE_ICONS_VERSION}/icons/${slug}.svg`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${slug}: HTTP ${r.status}`)
  const svg = await r.text()
  const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1])
  if (!paths.length) throw new Error(`${slug}: no paths found`)
  return paths
}

const tiles = []
for (const [i, [slug, title, color]] of ICONS.entries()) {
  const paths = await iconPaths(slug)
  tiles.push(`<g transform="translate(${i * STEP}, 0)">
  <title>${title}</title>
  <rect width="${TILE}" height="${TILE}" rx="60" fill="#242938"/>
  <g transform="translate(${OFFSET}, ${OFFSET}) scale(${SCALE})" fill="${color}">
    ${paths.map((d) => `<path d="${d}"/>`).join('\n    ')}
  </g>
</g>`)
}

const width = ICONS.length * STEP - (STEP - TILE)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${TILE}" viewBox="0 0 ${width} ${TILE}" role="img" aria-label="AI stack: ${ICONS.map((i) => i[1]).join(', ')}">
${tiles.join('\n')}
</svg>
`
await mkdir('assets', { recursive: true })
await writeFile('assets/ai-stack.svg', svg)
console.log(`assets/ai-stack.svg written (${ICONS.length} icons)`)
