/**
 * Genera las tarjetas SVG de métricas del perfil (incluye repos privados y de orgs).
 *
 * Corre en la GitHub Action. Sin dependencias: solo Node 22 (fetch nativo).
 *   GH_METRICS_TOKEN  PAT clásico con scopes repo, read:org, read:user
 *                     (autorizado por SSO para las orgs que se quieran contar).
 *
 * Privacidad: nunca se escribe el nombre de un repo privado ni de una org.
 * Solo salen totales, lenguajes agregados y el calendario de contribuciones.
 */
import { mkdir, writeFile } from 'node:fs/promises'

const token = process.env.GH_METRICS_TOKEN
if (!token) throw new Error('Falta GH_METRICS_TOKEN')

const OUT_DIR = 'metrics'

const GQL = `
query ($from: DateTime!, $to: DateTime!) {
  viewer {
    login
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalIssueContributions
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
      commitContributionsByRepository(maxRepositories: 100) {
        contributions { totalCount }
        repository {
          isPrivate
          owner { login }
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name color } }
          }
        }
      }
    }
  }
}`

async function fetchGitHub() {
  const to = new Date()
  const from = new Date(to)
  from.setFullYear(to.getFullYear() - 1)
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-metrics',
    },
    body: JSON.stringify({ query: GQL, variables: { from: from.toISOString(), to: to.toISOString() } }),
  })
  if (!r.ok) throw new Error(`GitHub GraphQL ${r.status}: ${await r.text()}`)
  const json = await r.json()
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '))
  return json.data.viewer
}

// ---------------------------------------------------------------- agregación

// Markup/estilos: inflan los bytes (dashboards, reportes) sin reflejar el trabajo real.
const EXCLUDED_LANGS = new Set(['HTML', 'CSS', 'SCSS', 'Less'])
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

function activity(days) {
  const activeDays = days.filter((d) => d.count > 0).length
  const byMonth = new Map()
  for (const d of days) {
    const k = d.date.slice(0, 7)
    byMonth.set(k, (byMonth.get(k) || 0) + d.count)
  }
  const [bestKey, bestCount] = [...byMonth.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
  const bestMonth = bestKey ? `${MESES[Number(bestKey.slice(5, 7)) - 1]} ${bestKey.slice(0, 4)}` : '-'
  return { activeDays, bestMonth, bestCount }
}

function aggregate(viewer) {
  const c = viewer.contributionsCollection
  const days = c.contributionCalendar.weeks.flatMap((w) =>
    w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount })),
  )

  const orgs = new Set()
  let privateRepos = 0
  let publicRepos = 0
  const lang = new Map()
  for (const item of c.commitContributionsByRepository) {
    const repo = item.repository
    if (repo.isPrivate) privateRepos++
    else publicRepos++
    if (repo.owner.login !== viewer.login) orgs.add(repo.owner.login)
    // Cada repo reparte sus commits según la proporción de cada lenguaje en ese repo:
    // así pesa más donde más trabajaste, no el repo con más bytes.
    const edges = (repo.languages?.edges ?? []).filter((e) => !EXCLUDED_LANGS.has(e.node.name))
    const repoBytes = edges.reduce((s, e) => s + e.size, 0)
    if (!repoBytes) continue
    for (const e of edges) {
      const prev = lang.get(e.node.name) ?? { name: e.node.name, color: e.node.color || '#8b949e', size: 0 }
      prev.size += item.contributions.totalCount * (e.size / repoBytes)
      lang.set(e.node.name, prev)
    }
  }
  const langAll = [...lang.values()].sort((a, b) => b.size - a.size)
  const langTotal = langAll.reduce((s, l) => s + l.size, 0) || 1
  const top = langAll.slice(0, 6).map((l) => ({ ...l, pct: (l.size / langTotal) * 100 }))
  const rest = langAll.slice(6).reduce((s, l) => s + l.size, 0)
  if (rest > 0) top.push({ name: 'Otros', color: '#6e7681', pct: (rest / langTotal) * 100 })

  return {
    total: c.contributionCalendar.totalContributions,
    commits: c.totalCommitContributions,
    prs: c.totalPullRequestContributions,
    reviews: c.totalPullRequestReviewContributions,
    issues: c.totalIssueContributions,
    restricted: c.restrictedContributionsCount,
    privateRepos,
    publicRepos,
    orgCount: orgs.size,
    activity: activity(days),
    weeks: c.contributionCalendar.weeks,
    languages: top,
  }
}

// ---------------------------------------------------------------- SVG

const THEMES = {
  dark: {
    bg: '#0d1117', border: '#30363d', text: '#e6edf3', muted: '#8b949e', accent: '#a597ff',
    heat: ['#161b22', '#2e2a6b', '#4b3fb0', '#6e5ce6', '#a597ff'],
  },
  light: {
    bg: '#ffffff', border: '#d0d7de', text: '#1f2328', muted: '#656d76', accent: '#5a46d6',
    heat: ['#ebedf0', '#d4ccff', '#a597ff', '#6e5ce6', '#4b3fb0'],
  },
}

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
const fmt = (n) => n.toLocaleString('es-AR')

function frame(t, w, h, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>text{font-family:${FONT}}</style>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${t.bg}" stroke="${t.border}"/>
<text x="24" y="36" font-size="16" font-weight="600" fill="${t.text}">${esc(title)}</text>
${body}
</svg>
`
}

function statsCard(m, t) {
  const items = [
    ['Contribuciones', fmt(m.total)],
    ['Commits', fmt(m.commits)],
    ['Pull requests', fmt(m.prs)],
    ['Code reviews', fmt(m.reviews)],
    ['Repos con commits', fmt(m.privateRepos + m.publicRepos)],
    ['Días activos', `${fmt(m.activity.activeDays)}`],
    ['Mejor mes', `${m.activity.bestMonth} · ${fmt(m.activity.bestCount)}`],
    ['Issues', fmt(m.issues)],
  ]
  const colW = 210
  const body = items
    .map(([label, value], i) => {
      const x = 24 + (i % 2) * colW
      const y = 72 + Math.floor(i / 2) * 44
      return `<text x="${x}" y="${y}" font-size="12" fill="${t.muted}">${esc(label)}</text>
<text x="${x}" y="${y + 20}" font-size="18" font-weight="600" fill="${i < 2 ? t.accent : t.text}">${esc(value)}</text>`
    })
    .join('\n')
  const note = `<text x="24" y="${72 + 4 * 44 + 4}" font-size="11" fill="${t.muted}">Últimos 12 meses · incluye repos privados (${fmt(m.privateRepos)})</text>`
  return frame(t, 460, 270, 'Actividad en GitHub', body + '\n' + note)
}

function langCard(m, t) {
  const w = 460
  const barX = 24
  const barW = w - 48
  let x = barX
  const segs = m.languages
    .map((l) => {
      const sw = (l.pct / 100) * barW
      const seg = `<rect x="${x.toFixed(2)}" y="56" width="${Math.max(sw, 0).toFixed(2)}" height="10" fill="${l.color}"/>`
      x += sw
      return seg
    })
    .join('\n')
  const bar = `<clipPath id="bar"><rect x="${barX}" y="56" width="${barW}" height="10" rx="5"/></clipPath>
<g clip-path="url(#bar)">${segs}</g>`
  const legend = m.languages
    .map((l, i) => {
      const lx = 24 + (i % 2) * 210
      const ly = 96 + Math.floor(i / 2) * 26
      return `<circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${l.color}"/>
<text x="${lx + 16}" y="${ly}" font-size="13" fill="${t.text}">${esc(l.name)} <tspan fill="${t.muted}">${l.pct.toFixed(1)}%</tspan></text>`
    })
    .join('\n')
  const rows = Math.ceil(m.languages.length / 2)
  return frame(t, w, 96 + rows * 26 + 8, 'Lenguajes más usados', bar + '\n' + legend)
}

function heatmapCard(m, t) {
  const cell = 11
  const gap = 3
  const step = cell + gap
  const left = 24
  const top = 64
  const level = (n) => (n === 0 ? 0 : n < 3 ? 1 : n < 6 ? 2 : n < 10 ? 3 : 4)
  const cells = []
  const months = []
  let lastMonth = -1
  m.weeks.forEach((w, wi) => {
    const firstDay = w.contributionDays[0]
    const month = Number(firstDay.date.slice(5, 7)) - 1
    if (month !== lastMonth && wi < m.weeks.length - 2) {
      months.push(`<text x="${left + wi * step}" y="${top - 8}" font-size="10" fill="${t.muted}">${MESES[month]}</text>`)
      lastMonth = month
    }
    for (const d of w.contributionDays) {
      const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay()
      cells.push(
        `<rect x="${left + wi * step}" y="${top + dow * step}" width="${cell}" height="${cell}" rx="2" fill="${t.heat[level(d.contributionCount)]}"/>`,
      )
    }
  })
  const width = left * 2 + m.weeks.length * step - gap
  const legendY = top + 7 * step + 18
  const right = width - left // borde derecho de la grilla
  const masW = 22 // ancho reservado para el texto "Más"
  const cellsStart = right - masW - 5 * step
  const legend = [
    `<text x="${cellsStart - 6}" y="${legendY + 9}" font-size="10" fill="${t.muted}" text-anchor="end">Menos</text>`,
    ...t.heat.map(
      (c, i) => `<rect x="${cellsStart + i * step}" y="${legendY}" width="${cell}" height="${cell}" rx="2" fill="${c}"/>`,
    ),
    `<text x="${right}" y="${legendY + 9}" font-size="10" fill="${t.muted}" text-anchor="end">Más</text>`,
    `<text x="${left}" y="${legendY + 9}" font-size="11" fill="${t.muted}">${fmt(m.total)} contribuciones en el último año</text>`,
  ]
  return frame(t, width, legendY + 30, 'Calendario de contribuciones', [...months, ...cells, ...legend].join('\n'))
}

// ---------------------------------------------------------------- main

const viewer = await fetchGitHub()
const m = aggregate(viewer)

// Log de control: solo conteos, nunca nombres.
console.log(
  `contribuciones=${m.total} commits=${m.commits} prs=${m.prs} reviews=${m.reviews} ` +
    `repos_privados=${m.privateRepos} repos_publicos=${m.publicRepos} orgs=${m.orgCount} ` +
    `dias_activos=${m.activity.activeDays} lenguajes=${m.languages.map((l) => `${l.name}:${l.pct.toFixed(0)}%`).join(',')}`,
)
if (m.restricted > 0) {
  console.warn(
    `::warning::Hay ${m.restricted} contribuciones privadas que el token no puede ver en detalle. ` +
      'Revisá los scopes del token y su autorización SSO para la org.',
  )
}

await mkdir(OUT_DIR, { recursive: true })
for (const [name, t] of Object.entries(THEMES)) {
  await writeFile(`${OUT_DIR}/stats-${name}.svg`, statsCard(m, t))
  await writeFile(`${OUT_DIR}/languages-${name}.svg`, langCard(m, t))
  await writeFile(`${OUT_DIR}/heatmap-${name}.svg`, heatmapCard(m, t))
}
console.log(`SVGs escritos en ${OUT_DIR}/`)
