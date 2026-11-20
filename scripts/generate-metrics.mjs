/**
 * Genera las tarjetas SVG de métricas del perfil (incluye repos privados y de orgs).
 *
 * Corre en la GitHub Action. Sin dependencias: solo Node 22 (fetch nativo).
 *   GH_METRICS_TOKEN  PAT clásico con scopes repo, read:org, read:user.
 *   ORG_GROUPS        "login=Etiqueta;login2=Etiqueta" — orgs que se muestran con
 *                     nombre en el gráfico mensual (varias orgs pueden compartir etiqueta).
 *                     Lo que no esté acá cae en "Personal y otros".
 *
 * Privacidad: nunca se escribe el nombre de un repo privado. De las orgs solo salen
 * las etiquetas configuradas en ORG_GROUPS.
 */
import { mkdir, writeFile } from 'node:fs/promises'

const token = process.env.GH_METRICS_TOKEN
if (!token) throw new Error('Falta GH_METRICS_TOKEN')

const OUT_DIR = 'metrics'
const REST_LABEL = 'Personal & other'
const ORG_GROUPS = new Map(
  (process.env.ORG_GROUPS || '')
    .split(';')
    .map((p) => p.split('=').map((s) => s.trim()))
    .filter(([k, v]) => k && v),
)

// Markup/estilos: inflan los bytes (dashboards, reportes) sin reflejar el trabajo real.
const EXCLUDED_LANGS = new Set(['HTML', 'CSS', 'SCSS', 'Less'])
const MESES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

async function gql(query, variables = {}) {
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-metrics',
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!r.ok) throw new Error(`GitHub GraphQL ${r.status}: ${await r.text()}`)
  const json = await r.json()
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '))
  return json.data
}

const MAIN_QUERY = `
query ($from: DateTime!, $to: DateTime!) {
  viewer {
    login
    organizations(first: 100) { nodes { id login } }
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

async function fetchMain() {
  const to = new Date()
  const from = new Date(to)
  from.setFullYear(to.getFullYear() - 1)
  const d = await gql(MAIN_QUERY, { from: from.toISOString(), to: to.toISOString() })
  return d.viewer
}

/** Últimos 12 meses calendario (el actual, parcial, incluido). */
function monthWindows(n = 12) {
  const now = new Date()
  const out = []
  for (let i = n - 1; i >= 0; i--) {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1))
    const to = i === 0 ? now : new Date(next.getTime() - 1000)
    out.push({ key: from.toISOString().slice(0, 7), from: from.toISOString(), to: to.toISOString() })
  }
  return out
}

/** Contribuciones por mes de una org (commits + PRs + issues + reviews). */
async function monthlyForOrg(orgId, months) {
  const fields = months
    .map(
      (m, i) => `m${i}: contributionsCollection(organizationID: "${orgId}", from: "${m.from}", to: "${m.to}") {
        totalCommitContributions totalPullRequestContributions
        totalPullRequestReviewContributions totalIssueContributions }`,
    )
    .join('\n')
  const d = await gql(`{ viewer { ${fields} } }`)
  return months.map((_, i) => {
    const c = d.viewer[`m${i}`]
    return (
      c.totalCommitContributions +
      c.totalPullRequestContributions +
      c.totalPullRequestReviewContributions +
      c.totalIssueContributions
    )
  })
}

// ---------------------------------------------------------------- agregación

function activity(days) {
  const activeDays = days.filter((d) => d.count > 0).length
  const byMonth = new Map()
  for (const d of days) {
    const k = d.date.slice(0, 7)
    byMonth.set(k, (byMonth.get(k) || 0) + d.count)
  }
  const [bestKey, bestCount] = [...byMonth.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
  const bestMonth = bestKey ? `${MESES[Number(bestKey.slice(5, 7)) - 1]} ${bestKey.slice(0, 4)}` : '-'
  return { activeDays, bestMonth, bestCount, byMonth }
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
  if ((rest / langTotal) * 100 >= 0.5) top.push({ name: 'Other', color: '#6e7681', pct: (rest / langTotal) * 100 })

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
    languages: top,
  }
}

/**
 * Serie mensual por empresa. El calendario da el total de cada mes; lo que no
 * corresponde a una org configurada queda en "Personal y otros".
 */
async function monthlyByCompany(viewer, m) {
  const months = monthWindows()
  const idByLogin = new Map(viewer.organizations.nodes.map((o) => [o.login.toLowerCase(), o.id]))
  const labels = [...new Set(ORG_GROUPS.values())]
  const byLabel = new Map(labels.map((l) => [l, months.map(() => 0)]))

  for (const [login, label] of ORG_GROUPS) {
    const id = idByLogin.get(login.toLowerCase())
    if (!id) {
      console.warn(`::warning::Org ${login} from ORG_GROUPS is not visible with the token; skipped.`)
      continue
    }
    const series = await monthlyForOrg(id, months)
    const acc = byLabel.get(label)
    series.forEach((v, i) => (acc[i] += v))
  }

  const rest = months.map((mo, i) => {
    const total = m.activity.byMonth.get(mo.key) || 0
    const orgsSum = labels.reduce((s, l) => s + byLabel.get(l)[i], 0)
    return Math.max(0, total - orgsSum)
  })

  const series = labels
    .map((label) => ({ label, values: byLabel.get(label) }))
    .filter((s) => s.values.some((v) => v > 0))
    .sort((a, b) => sum(b.values) - sum(a.values))
  if (rest.some((v) => v > 0)) series.push({ label: REST_LABEL, values: rest, rest: true })
  return { months: months.map((mo) => mo.key), series }
}

const sum = (arr) => arr.reduce((s, v) => s + v, 0)

// ---------------------------------------------------------------- SVG

const THEMES = {
  dark: {
    bg: '#0d1117', border: '#30363d', text: '#e6edf3', muted: '#8b949e', accent: '#a597ff', grid: '#21262d',
    series: ['#a597ff', '#3fb8af', '#f0a04b', '#e8699a', '#58a6ff'], rest: '#484f58',
  },
  light: {
    bg: '#ffffff', border: '#d0d7de', text: '#1f2328', muted: '#656d76', accent: '#5a46d6', grid: '#eaeef2',
    series: ['#5a46d6', '#1f8a82', '#c46f12', '#c2386f', '#0969da'], rest: '#afb8c1',
  },
}

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
const fmt = (n) => Math.round(n).toLocaleString('en-US')

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
    ['Contributions', fmt(m.total)],
    ['Commits', fmt(m.commits)],
    ['Pull requests', fmt(m.prs)],
    ['Code reviews', fmt(m.reviews)],
    ['Repositories', fmt(m.privateRepos + m.publicRepos)],
    ['Active days', `${fmt(m.activity.activeDays)}`],
    ['Best month', `${m.activity.bestMonth} · ${fmt(m.activity.bestCount)}`],
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
  const note = `<text x="24" y="${72 + 4 * 44 + 4}" font-size="11" fill="${t.muted}">Last 12 months · includes private repositories (${fmt(m.privateRepos)})</text>`
  return frame(t, 460, 270, 'GitHub activity', body + '\n' + note)
}

/** One horizontal bar per language: name · bar (relative to the top one) · percentage. */
function langCard(m, t) {
  const w = 460
  const nameW = 130
  const pctW = 52
  const barX = 24 + nameW
  const barMax = w - 24 - pctW - barX
  const rowH = 28
  const top = 62
  const maxPct = Math.max(...m.languages.map((l) => l.pct), 1)
  // Some language colors (e.g. PowerShell navy) vanish on a dark background.
  const visible = (hex) => {
    const n = parseInt(hex.slice(1), 16)
    const lum = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
    return t.bg === THEMES.dark.bg && lum < 0.25 ? t.muted : hex
  }
  const rows = m.languages
    .map((l, i) => {
      const y = top + i * rowH
      const bw = Math.max(3, (l.pct / maxPct) * barMax)
      return `<text x="24" y="${y + 9}" font-size="13" fill="${t.text}">${esc(l.name)}</text>
<rect x="${barX}" y="${y}" width="${barMax}" height="10" rx="5" fill="${t.grid}"/>
<rect x="${barX}" y="${y}" width="${bw.toFixed(1)}" height="10" rx="5" fill="${visible(l.color)}"/>
<text x="${w - 24}" y="${y + 9}" font-size="12" fill="${t.muted}" text-anchor="end">${l.pct.toFixed(1)}%</text>`
    })
    .join('\n')
  return frame(t, w, Math.max(270, top + m.languages.length * rowH + 12), 'Most used languages', rows)
}

function niceMax(v) {
  if (v <= 0) return 10
  const p = 10 ** Math.floor(Math.log10(v))
  for (const k of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * p >= v) return k * p
  return 10 * p
}

function monthlyCard(data, t) {
  const W = 936
  const H = 320
  const left = 56
  const right = 24
  const top = 92
  const bottom = 44
  const plotW = W - left - right
  const plotH = H - top - bottom
  const n = data.months.length
  const slot = plotW / n
  const barW = Math.min(44, slot * 0.62)
  const color = (s, i) => (s.rest ? t.rest : t.series[i % t.series.length])

  const totals = data.months.map((_, i) => sum(data.series.map((s) => s.values[i])))
  const max = niceMax(Math.max(...totals))
  const y = (v) => top + plotH - (v / max) * plotH

  // Leyenda en una fila bajo el título.
  let lx = 24
  const legend = data.series
    .map((s, i) => {
      const label = `${s.label}`
      const total = fmt(sum(s.values))
      const item = `<rect x="${lx}" y="52" width="10" height="10" rx="2" fill="${color(s, i)}"/>
<text x="${lx + 16}" y="61" font-size="12" fill="${t.text}">${esc(label)} <tspan fill="${t.muted}">${total}</tspan></text>`
      lx += 16 + (label.length + total.length + 1) * 7 + 22
      return item
    })
    .join('\n')

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const v = max * f
      return `<line x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}" stroke="${t.grid}"/>
<text x="${left - 8}" y="${y(v) + 4}" font-size="10" fill="${t.muted}" text-anchor="end">${fmt(v)}</text>`
    })
    .join('\n')

  const bars = data.months
    .map((key, i) => {
      const cx = left + slot * i + slot / 2
      const x0 = cx - barW / 2
      let acc = 0
      const segs = data.series
        .map((s, si) => {
          const v = s.values[i]
          if (!v) return ''
          const yTop = y(acc + v)
          const h = y(acc) - yTop
          acc += v
          return `<rect x="${x0.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, 0).toFixed(1)}" fill="${color(s, si)}"/>`
        })
        .join('')
      const mes = MESES[Number(key.slice(5, 7)) - 1]
      const anio = key.slice(2, 4)
      const label = `<text x="${cx}" y="${H - bottom + 18}" font-size="11" fill="${t.muted}" text-anchor="middle">${mes} ${anio}</text>`
      const tot = totals[i]
        ? `<text x="${cx}" y="${y(totals[i]) - 6}" font-size="10" fill="${t.muted}" text-anchor="middle">${fmt(totals[i])}</text>`
        : ''
      return segs + label + tot
    })
    .join('\n')

  return frame(t, W, H, 'Contributions by month and company', [legend, grid, bars].join('\n'))
}

// ---------------------------------------------------------------- main

const viewer = await fetchMain()
const m = aggregate(viewer)
const monthly = await monthlyByCompany(viewer, m)

// Log de control (el log es público): conteos y etiquetas configuradas, nunca repos.
console.log(
  `contribuciones=${m.total} commits=${m.commits} prs=${m.prs} reviews=${m.reviews} ` +
    `repos_privados=${m.privateRepos} repos_publicos=${m.publicRepos} orgs=${m.orgCount} ` +
    `dias_activos=${m.activity.activeDays} lenguajes=${m.languages.map((l) => `${l.name}:${l.pct.toFixed(0)}%`).join(',')}`,
)
console.log(`por_empresa=${monthly.series.map((s) => `${s.label}:${sum(s.values)}`).join(',')}`)
if (m.restricted > 0) {
  console.warn(
    `::warning::${m.restricted} private contributions are not visible in detail with this token. ` +
      'Check the token scopes.',
  )
}

await mkdir(OUT_DIR, { recursive: true })
for (const [name, t] of Object.entries(THEMES)) {
  await writeFile(`${OUT_DIR}/stats-${name}.svg`, statsCard(m, t))
  await writeFile(`${OUT_DIR}/languages-${name}.svg`, langCard(m, t))
  await writeFile(`${OUT_DIR}/monthly-${name}.svg`, monthlyCard(monthly, t))
}
console.log(`SVGs escritos en ${OUT_DIR}/`)
