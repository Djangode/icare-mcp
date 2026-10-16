#!/usr/bin/env node
// Agent autonome d'ICARE : il tourne seul sur la machine de son propriétaire avec son propre wallet (celui du MCP),
// surveille les parties en direct, décide d'après la stratégie écrite en langage courant (Claude, GPT ou Gemini par leur
// ligne de commande, ou une règle intégrée sans IA), mise dans les limites fixées par le propriétaire, revend quand le
// gain visé est atteint, suit chaque règlement et note chaque action dans un journal.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IcareError, config, latestBlock, observedRows, payoutOf, placeBet, sell, sellQuote, summary, unitsHeld, usdc, walletInfo } from './icare.mjs'

const DIR = process.env.ICARE_AGENT_DIR || path.join(os.homedir(), '.icare-agent')
const MEMORY = path.join(DIR, 'state.json'), JOURNAL = path.join(DIR, 'journal.jsonl'), LOCK = path.join(DIR, 'agent.pid')
export const DEFAULTS = { strategy: '', brain: 'rules', brainCmd: '', stake: 1, maxStake: 5, daily: 10, maxOpen: 3, takeProfit: 0.3, interval: 60, edge: 0.1 }
// Claude Code en une question, sans outils, sans extensions ni serveurs MCP de l'utilisateur.
export const CLAUDE = ['claude', '-p', '--setting-sources', '', '--strict-mcp-config', '--model', 'haiku', '--tools', '', '--no-session-persistence']
// Une mise payée en x402 coûte la mise + 0,20 USDC (0,10 depuis le Portfolio) : la limite du jour compte le cas le plus cher.
const NETWORK_FEES = 0.2
const pct = value => `${Math.round(value * 100)}%`
const HELP = `ICARE autonomous agent: watches live ICARE matches, decides with your strategy, bets within your limits, sells at your profit target and logs every action.

  icare-agent run      run on its own until stopped (Ctrl+C)
  icare-agent once     one scan, then exit (for cron or tests)
  icare-agent status   wallet, settings, positions and last actions

Options (saved for the next runs):
  --strategy "..."     your strategy in plain English, used by the AI brains
  --brain rules        built-in rule, no AI: bets when the streamer's ICARE record beats the price by --edge (default)
  --brain claude       asks Claude through Claude Code (claude -p)
  --brain command --brain-cmd "codex exec"   any CLI that takes the prompt as last argument (GPT: "codex exec", Gemini: "gemini -p")
  --stake 1            default stake in USDC (ICARE accepts 1 to 50)
  --max-stake 5        highest stake the brain may choose
  --daily 10           USDC spent at most over 24 h, network fees included
  --max-open 3         positions open at the same time
  --take-profit 0.3    sells when the buyback pays 30% over the stake (0 = hold until the result)
  --interval 60        seconds between scans
  --edge 0.1           rules brain: minimum gap between record and price

Wallet: the same as icare-mcp (ICARE_AGENT_PRIVATE_KEY, or created in ~/.icare-mcp.json on first use). Fund it with test USDC
on Base Sepolia (https://faucet.circle.com). Memory and journal: ${DIR}`

export function parseArgs(argv) {
  const [command = 'status', ...rest] = argv
  if (['help', '--help', '-h'].includes(command)) return { command: 'help', flags: {} }
  if (!['run', 'once', 'status'].includes(command)) throw new Error(`Unknown command "${command}". Try: icare-agent help`)
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    const found = /^--([a-z-]+)$/.exec(rest[i])
    if (!found) throw new Error(`Unexpected argument "${rest[i]}"`)
    const key = found[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    if (!(key in DEFAULTS)) throw new Error(`Unknown option --${found[1]}`)
    const value = rest[++i]
    if (value === undefined) throw new Error(`Missing value for --${found[1]}`)
    flags[key] = typeof DEFAULTS[key] === 'number' ? Number(value) : value
    if (typeof DEFAULTS[key] === 'number' && !Number.isFinite(flags[key])) throw new Error(`--${found[1]} must be a number`)
  }
  return { command, flags }
}

export function checkSettings(settings) {
  if (!['rules', 'claude', 'command'].includes(settings.brain)) throw new Error('--brain must be rules, claude or command')
  if (settings.brain === 'command' && !settings.brainCmd.trim()) throw new Error('--brain command needs --brain-cmd, for example "codex exec" or "gemini -p"')
  if (settings.stake < 1 || settings.maxStake < settings.stake || settings.maxStake > 50) throw new Error('Stakes must satisfy 1 ≤ --stake ≤ --max-stake ≤ 50')
  if (settings.daily < settings.stake + NETWORK_FEES) throw new Error(`--daily must cover at least one stake + ${NETWORK_FEES} USDC of network fees`)
  if (!Number.isInteger(settings.maxOpen) || settings.maxOpen < 1) throw new Error('--max-open must be a whole number ≥ 1')
  if (settings.takeProfit < 0 || settings.interval < 15 || settings.edge < 0 || settings.edge >= 1) throw new Error('Check --take-profit ≥ 0, --interval ≥ 15 and 0 ≤ --edge < 1')
  return settings
}

// Bilan du streamer sur ICARE pour ce jeu, parties les plus récentes d'abord.
export function playerRecord(rows, player, game) {
  const own = rows.filter(row => row.observed?.playerName === player && row.observed?.gameAppId === game)
    .sort((a, b) => (b.observed?.startedAtMs || 0) - (a.observed?.startedAtMs || 0))
  const settled = own.filter(row => !row.cancelled && row.winnerSide != null)
  const wins = settled.filter(row => row.observed?.result === 'Win').length
  return { settled: settled.length, wins, losses: settled.length - wins, refunded: own.filter(row => row.cancelled).length,
    lastResults: settled.slice(0, 10).map(row => row.observed.result) }
}

// Règle intégrée, sans IA : taux de victoire lissé du streamer sur ICARE comparé au prix de chaque camp.
export function rulesDecision({ match, record }, edge) {
  if (!(match.winPrice > 0 && match.losePrice > 0)) return { bet: false, reason: 'no market price yet' }
  if (record.settled < 3) return { bet: false, reason: `only ${record.settled} settled games for ${match.player} on ICARE` }
  const pWin = (record.wins + 1) / (record.settled + 2)
  if (pWin - match.winPrice >= edge) return { bet: true, side: 'win', reason: `${match.player} won ${record.wins}/${record.settled} on ICARE (≈${pct(pWin)}) and Win costs ${pct(match.winPrice)}` }
  if (1 - pWin - match.losePrice >= edge) return { bet: true, side: 'lose', reason: `${match.player} lost ${record.losses}/${record.settled} on ICARE (≈${pct(1 - pWin)}) and Lose costs ${pct(match.losePrice)}` }
  return { bet: false, reason: `no edge: ≈${pct(pWin)} win rate against Win at ${pct(match.winPrice)}` }
}

export function decisionPrompt(context, settings, limits) {
  return ['You are an autonomous betting agent on ICARE: Win/Lose prediction markets on live streamer games, settled by an AI referee that reads the stream. Season 0 uses Base Sepolia test USDC.',
    `Owner strategy: ${settings.strategy.trim() || 'none given; only bet when the price looks clearly wrong given the streamer record.'}`,
    'A side price is its implied probability and each winning unit pays 1 USDC. "win" means the streamer wins this game.',
    `Limits: stake from ${limits.min} to ${limits.max} USDC; ${limits.left.toFixed(2)} USDC left today.`,
    `Match: ${JSON.stringify(context.match)}`,
    `Streamer record on ICARE for this game: ${JSON.stringify(context.record)}`,
    'Answer with only one JSON object: {"bet": true or false, "side": "win" or "lose", "stakeUsdc": number, "reason": "one short sentence"}.'].join('\n')
}

export function parseDecision(text) {
  const found = String(text).match(/\{[\s\S]*\}/)
  if (!found) throw new Error('the brain gave no JSON decision')
  const raw = JSON.parse(found[0])
  if (raw.bet !== true) return { bet: false, reason: String(raw.reason || 'skip').slice(0, 300) }
  if (!['win', 'lose'].includes(raw.side)) throw new Error('the brain decision side must be "win" or "lose"')
  const stake = raw.stakeUsdc == null ? null : Number(raw.stakeUsdc)
  if (stake != null && !Number.isFinite(stake)) throw new Error('the brain decision stakeUsdc must be a number')
  return { bet: true, side: raw.side, stakeUsdc: stake, reason: String(raw.reason || '').slice(0, 300) }
}

export const spentLast24h = (bets, now) => bets.filter(bet => now - bet.at < 86_400_000).reduce((sum, bet) => sum + bet.stake + NETWORK_FEES, 0)

// Limites du propriétaire, appliquées quoi que décide le cerveau.
export function guard(decision, { settings, cfg, bets, now, closesAt }) {
  if (!decision.bet) return { ok: false, reason: decision.reason }
  const min = Number(cfg.minStake) / 1e6, max = Math.min(Number(cfg.maxStake) / 1e6, settings.maxStake)
  const stake = Math.round(Math.min(max, Math.max(min, decision.stakeUsdc ?? settings.stake)) * 100) / 100
  const open = bets.filter(bet => !bet.outcome).length
  if (open >= settings.maxOpen) return { ok: false, reason: `${open} positions already open (limit ${settings.maxOpen})` }
  const spent = spentLast24h(bets, now)
  if (spent + stake + NETWORK_FEES > settings.daily + 1e-9) return { ok: false, reason: `daily limit: ${spent.toFixed(2)} of ${settings.daily} USDC used over 24 h` }
  if (closesAt && closesAt * 1000 - now < 20_000) return { ok: false, reason: 'predictions close in less than 20 s' }
  return { ok: true, stake }
}

export const takeProfitReached = (bet, proceedsUsdc, takeProfit) => takeProfit > 0 && proceedsUsdc >= bet.stake * (1 + takeProfit)

export function ask(command, prompt, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), prompt], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', error => { clearTimeout(timer); reject(new Error(`cannot start "${command[0]}": ${error.message}`)) })
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`"${command[0]}" exited with ${code}: ${(err || out).trim().slice(0, 200)}`)) })
  })
}

async function readMemory() {
  try { const saved = JSON.parse(await fsp.readFile(MEMORY, 'utf8')); return { settings: {}, decided: {}, bets: [], ...saved } } catch { return { settings: {}, decided: {}, bets: [] } }
}
async function saveMemory(memory) {
  const week = Date.now() - 7 * 86_400_000
  for (const [id, decision] of Object.entries(memory.decided)) if (decision.at < week) delete memory.decided[id]
  await fsp.mkdir(DIR, { recursive: true })
  await fsp.writeFile(`${MEMORY}.tmp`, JSON.stringify(memory, null, 2), { mode: 0o600 })
  await fsp.rename(`${MEMORY}.tmp`, MEMORY)
}
async function log(type, data) {
  await fsp.mkdir(DIR, { recursive: true })
  await fsp.appendFile(JOURNAL, JSON.stringify({ time: new Date().toISOString(), type, ...data }) + '\n', { mode: 0o600 })
  const where = data.matchId ? ` #${data.matchId}${data.player ? ` ${data.player} (${data.game})` : ''}` : ''
  const detail = type === 'bet' ? `${data.side.toUpperCase()} ${data.stakeUsdc} USDC at ${pct(data.price)} — ${data.reason}${data.tx ? ` · tx ${data.tx}` : ''}`
    : type === 'decision' ? `skip — ${data.reason}`
    : type === 'sold' ? `sold ${data.side.toUpperCase()} for ${data.proceedsUsdc} USDC (stake ${data.stakeUsdc})`
    : type === 'settled' ? `${data.outcome.toUpperCase()} — result ${data.result}${data.outcome === 'lost' ? '' : data.payoutUsdc == null ? ', payout credited by ICARE to the Portfolio'
      : `, ${data.payoutUsdc} USDC ${data.credited ? 'credited to the Portfolio' : 'claimable'}`}`
    : type === 'error' ? `${data.step}: ${data.message}` : JSON.stringify(data)
  console.log(`${new Date().toLocaleTimeString('en-GB')} ${type}${where} ${detail}`)
}

// Un passage : règlements, revente au gain visé, puis décision sur chaque partie ouverte.
export async function scan(settings, memory) {
  const cfg = await config()
  const rows = (await observedRows()).sort((a, b) => (b.observed?.startedAtMs || 0) - (a.observed?.startedAtMs || 0))
  const byId = new Map(rows.map(row => [String(row.matchId), row]))
  for (const bet of memory.bets.filter(bet => !bet.outcome)) {
    const row = byId.get(bet.matchId)
    if (!row) continue
    const match = summary(row)
    if (match.status !== 'settled' && match.status !== 'refunded') {
      const held = await unitsHeld(bet.matchId).catch(() => null)
      if (held) bet.units = usdc(bet.side === 'win' ? held.win : held.lose)
      if (match.status !== 'open' || !(Number(bet.units) > 0) || !(settings.takeProfit > 0)) continue
      const quote = await sellQuote({ matchId: bet.matchId, side: bet.side }).catch(() => null)
      const proceeds = quote ? Number(usdc(quote.sellerProceeds)) : 0
      if (!quote || !takeProfitReached(bet, proceeds, settings.takeProfit)) continue
      try {
        await sell({ matchId: bet.matchId, side: bet.side })
        Object.assign(bet, { outcome: 'sold', proceeds, closedAt: Date.now() })
        await log('sold', { matchId: bet.matchId, player: bet.player, game: bet.game, side: bet.side, stakeUsdc: bet.stake, proceedsUsdc: proceeds })
      } catch (error) { await log('error', { matchId: bet.matchId, step: 'sell', message: error.message }) }
    } else {
      const outcome = match.status === 'refunded' ? 'refunded' : String(match.result).toLowerCase() === bet.side ? 'won' : 'lost'
      // ICARE verse le gain au Portfolio peu après le règlement : tant qu'il n'est ni réclamable ni versé, on repasse.
      const paid = outcome === 'lost' ? { payout: 0n, credited: false } : bet.block ? await payoutOf(bet.matchId, bet.block).catch(() => null) : null
      if (outcome !== 'lost' && paid && paid.payout === 0n && !paid.credited && Date.now() - (bet.seenSettledAt ||= Date.now()) < 30 * 60_000) continue
      const payoutUsdc = paid && paid.payout != null ? usdc(paid.payout) : null
      Object.assign(bet, { outcome, closedAt: Date.now(), payout: payoutUsdc })
      await log('settled', { matchId: bet.matchId, player: bet.player, game: bet.game, side: bet.side, stakeUsdc: bet.stake, result: match.result || 'refunded', outcome,
        payoutUsdc, credited: paid?.credited ?? null, proof: match.proof })
    }
  }
  const min = Number(cfg.minStake) / 1e6, max = Math.min(Number(cfg.maxStake) / 1e6, settings.maxStake)
  for (const row of rows) {
    const match = summary(row), id = String(row.matchId)
    if (match.status !== 'open' || memory.bets.some(bet => bet.matchId === id)) continue
    // Les cerveaux IA décident une fois par partie ; la règle intégrée, gratuite, réévalue à chaque passage.
    if (settings.brain !== 'rules' && memory.decided[id]) continue
    const now = Date.now()
    const context = { match: { matchId: id, player: match.player, game: match.game, winPrice: match.winPrice, losePrice: match.losePrice, potUsdc: match.potUsdc,
      closesInSeconds: Math.max(0, Math.round(row.observed.closesAt - now / 1000)), stream: match.stream }, record: playerRecord(rows, match.player, match.game) }
    let decision
    try {
      decision = settings.brain === 'rules' ? rulesDecision(context, settings.edge)
        : parseDecision(await ask(settings.brain === 'claude' ? CLAUDE : settings.brainCmd.trim().split(/\s+/),
          decisionPrompt(context, settings, { min, max, left: Math.max(0, settings.daily - spentLast24h(memory.bets, now)) })))
    } catch (error) {
      memory.decided[id] = { at: now, bet: false, reason: error.message }
      await log('error', { matchId: id, player: match.player, game: match.game, step: 'decision', message: error.message })
      continue
    }
    const verdict = guard(decision, { settings, cfg, bets: memory.bets, now, closesAt: row.observed.closesAt })
    const first = !memory.decided[id]
    memory.decided[id] = { at: now, bet: verdict.ok, reason: verdict.ok ? decision.reason : verdict.reason }
    if (!verdict.ok) { if (first) await log('decision', { matchId: id, player: match.player, game: match.game, reason: verdict.reason }); continue }
    const price = decision.side === 'win' ? match.winPrice : match.losePrice
    try {
      const placed = await placeBet({ matchId: id, side: decision.side, stakeUsdc: verdict.stake.toFixed(2) })
      const [held, block] = await Promise.all([unitsHeld(id).catch(() => null), latestBlock().catch(() => null)])
      memory.bets.push({ matchId: id, player: match.player, game: match.game, side: decision.side, stake: verdict.stake, price, at: Date.now(), tx: placed.betTx || null, paidFrom: placed.paidFrom || 'x402',
        units: held ? usdc(decision.side === 'win' ? held.win : held.lose) : null, block })
      await log('bet', { matchId: id, player: match.player, game: match.game, side: decision.side, stakeUsdc: verdict.stake, price, reason: decision.reason, tx: placed.betTx || null, paidFrom: placed.paidFrom || 'x402' })
    } catch (error) {
      memory.decided[id] = { at: now, bet: false, reason: error.message }
      await log('error', { matchId: id, player: match.player, game: match.game, step: 'bet', message: error.message })
    }
    await saveMemory(memory)
  }
  await saveMemory(memory)
}

async function status(memory, settings) {
  const info = await walletInfo().catch(error => ({ error: error.message }))
  console.log(info.error ? `Wallet unavailable: ${info.error}` : `Wallet ${info.address} (${info.network}) · wallet ${info.walletUsdc} USDC · Portfolio ${info.portfolioUsdc} USDC`)
  console.log(`Settings: ${JSON.stringify(settings)}`)
  const count = outcome => memory.bets.filter(bet => bet.outcome === outcome).length
  console.log(`Bets: ${memory.bets.length} · open ${memory.bets.filter(bet => !bet.outcome).length} · won ${count('won')} · lost ${count('lost')} · sold ${count('sold')} · refunded ${count('refunded')}`)
  const lines = (await fsp.readFile(JOURNAL, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).slice(-10)
  console.log(lines.length ? `Last actions (${JOURNAL}):\n${lines.join('\n')}` : 'No action yet.')
}

// Un seul agent par wallet sur la machine : deux boucles miseraient deux fois.
function lock() {
  fs.mkdirSync(DIR, { recursive: true })
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'))
    if (pid && pid !== process.pid) { process.kill(pid, 0); throw new IcareError(`Another icare-agent is running (pid ${pid}).`) }
  } catch (error) { if (error instanceof IcareError) throw error }
  fs.writeFileSync(LOCK, String(process.pid))
  process.on('exit', () => { try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK) } catch {} })
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2))
  if (command === 'help') return console.log(HELP)
  const memory = await readMemory()
  const settings = checkSettings({ ...DEFAULTS, ...memory.settings, ...flags })
  memory.settings = settings
  if (command === 'status') return status(memory, settings)
  lock()
  await saveMemory(memory)
  const info = await walletInfo()
  console.log(`ICARE agent · wallet ${info.address} · wallet ${info.walletUsdc} USDC · Portfolio ${info.portfolioUsdc} USDC · brain ${settings.brain === 'command' ? settings.brainCmd : settings.brain}`)
  console.log(`Limits: stake ${settings.stake} (max ${settings.maxStake}) · ${settings.daily} USDC per 24 h · ${settings.maxOpen} open · take profit ${pct(settings.takeProfit)} · journal ${JOURNAL}`)
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (stopping) process.exit(1); stopping = true; console.log('Stopping after this scan…') })
  do {
    try { await scan(settings, memory) } catch (error) { await log('error', { step: 'scan', message: error.message }) }
    if (command === 'once') break
    for (let waited = 0; waited < settings.interval && !stopping; waited++) await new Promise(resolve => setTimeout(resolve, 1000))
  } while (!stopping)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof IcareError ? error.message : error.message || error); process.exit(1) })
}
