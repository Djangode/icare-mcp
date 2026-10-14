#!/usr/bin/env node
// Serveur MCP d'ICARE : un agent IA suit les parties en direct arbitrées par l'IA d'ICARE (streamers Twitch, Kick…),
// prédit Win / Lose avec une mise USDC payée en x402 (sans gaz, sans ETH), revend sa position à tout moment à la
// liquidité ICARE, et lit ses positions et la Saison 0. La clé privée de l'agent signe sur sa machine ; elle n'est
// jamais envoyée. Quand les codes d'accès d'ICARE sont actifs, un code (Discord d'ICARE) active le wallet une fois.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { ethers } from 'ethers'
import { encodePaymentSignatureHeader } from '@x402/core/http'

const API = (process.env.ICARE_API_URL || 'https://api.icarehub.xyz').replace(/\/+$/, '')
const APP = (process.env.ICARE_APP_URL || 'https://app.icarehub.xyz').replace(/\/+$/, '')
const SEASON = process.env.ICARE_SEASON_URL || 'https://superdash-api.icarehub.xyz/api/indexed/icare/season0'
const RPC = process.env.ICARE_RPC_URL || 'https://sepolia.base.org'
const STATE = process.env.ICARE_STATE_FILE || path.join(os.homedir(), '.icare-mcp.json')
const DISCORD = 'https://discord.gg/SmRynyJmnK'
const USDC = 1_000_000n
const provider = new ethers.JsonRpcProvider(RPC)
const ENV_KEY = /^(0x)?[0-9a-fA-F]{64}$/.test(process.env.ICARE_AGENT_PRIVATE_KEY || '') ? process.env.ICARE_AGENT_PRIVATE_KEY : null
let wallet = ENV_KEY ? new ethers.Wallet(ENV_KEY, provider) : null
const MATCH_ABI = ['function marketId(uint256) view returns(bytes32)', 'function predictionFor(uint256) view returns(address)',
  'function placePrediction(uint256,uint8,uint256)']
const FUNDS_ABI = ['function executionNonce(address) view returns(uint256)', 'function balanceOf(address) view returns(uint256)',
  'function actionDigest((address account,address target,uint256 value,uint256 relayFee,uint256 nonce,uint64 deadline,bytes data)) view returns(bytes32)']
const PREDICTION_ABI = ['function positionsOf(bytes32,address) view returns(uint256[4])',
  'function quoteTransferFees(bytes32,uint256) view returns(uint256 appFee,uint256 protocolFee,uint256 sellerProceeds)']
const OFFER_TYPES = { PositionOffer: [{ name: 'questionId', type: 'bytes32' }, { name: 'seller', type: 'address' }, { name: 'outcome', type: 'uint8' },
  { name: 'units', type: 'uint256' }, { name: 'price', type: 'uint256' }, { name: 'minSellerProceeds', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }] }
const AUTHORIZATION_TYPES = { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }

const usdc = units => ethers.formatUnits(units, 6)
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const failure = message => ({ isError: true, content: [{ type: 'text', text: message }] })
// Comme le CLI de MoonPay : sans clé fournie, le wallet de l'agent est créé sur cette machine au premier usage et gardé
// dans le fichier d'état (droits 600) ; la clé n'en sort jamais.
let walletPromise = null
const ensureWallet = () => walletPromise ||= (async () => {
  if (wallet) return wallet
  const saved = await state()
  let key = /^0x[0-9a-fA-F]{64}$/.test(saved.agentKey || '') ? saved.agentKey : null
  if (!key) { key = ethers.Wallet.createRandom().privateKey; await saveState({ ...saved, agentKey: key }) }
  wallet = new ethers.Wallet(key, provider)
  return wallet
})().catch(error => { walletPromise = null; throw error })
// Un pari payé en x402 enchaîne trois transactions confirmées côté ICARE (encaissement, crédit, relais) : ~40 s.
async function json(url, init = {}, timeoutMs = 30_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const body = await response.json().catch(() => null)
  return { status: response.status, headers: response.headers, body }
}
async function state() { try { return JSON.parse(await fs.readFile(STATE, 'utf8')) } catch { return {} } }
async function saveState(next) {
  await fs.mkdir(path.dirname(STATE), { recursive: true })
  await fs.writeFile(STATE, JSON.stringify(next, null, 2), { mode: 0o600 })
  await fs.chmod(STATE, 0o600)
}
let configPromise = null
const config = () => (configPromise ||= json(`${API}/api/agents/config`).then(({ status, body }) => {
  if (status !== 200 || !body?.match) { configPromise = null; throw new Error('ICARE agent API unavailable, retry later.') }
  return body
}))
async function accessSession() {
  const saved = (await state())[wallet.address.toLowerCase()]?.access
  const value = process.env.ICARE_ACCESS_SESSION || saved
  if (!value) throw new Error(`This wallet is not activated. Get an access code in the ICARE Discord (${DISCORD}) and call icare_activate.`)
  return value
}
function summary(row) {
  const prices = (row.marketPrices || []).map(value => Number(BigInt(value) * 10_000n / 10n ** 18n) / 10_000)
  const observed = row.observed || {}
  const status = row.cancelled ? 'refunded' : row.winnerSide != null ? 'settled' : observed.inProgress ? (Date.now() / 1000 < observed.closesAt ? 'open' : 'in_progress_closed') : 'verifying'
  return { matchId: row.matchId, player: observed.playerName, game: observed.gameAppId, status, closesAt: observed.closesAt ? new Date(observed.closesAt * 1000).toISOString() : null,
    winPrice: prices[0], losePrice: prices[1], potUsdc: usdc(row.marketVolume || '0'), result: observed.result || null,
    proof: observed.proofCid ? `${API}/ipfs/${observed.proofCid}` : null, stream: observed.streamUrl || null, page: `${APP}/en/arena/match/${row.matchId}` }
}
async function market(matchId) {
  const { match } = await config()
  const contract = new ethers.Contract(match, MATCH_ABI, provider)
  const [questionId, prediction] = await Promise.all([contract.marketId(matchId), contract.predictionFor(matchId)])
  return { questionId, prediction: new ethers.Contract(prediction, PREDICTION_ABI, provider), predictionAddress: prediction }
}

const server = new McpServer({ name: 'icare', version: '0.1.0' }, { instructions:
  'ICARE runs Win/Lose prediction markets on live streamer games (CS2, Valorant, EA FC, Rocket League, League of Legends…) settled by an AI referee that reads the stream and publishes an on-chain proof. ' +
  'Season 0 runs on the Base Sepolia testnet with test USDC: correct predictions score +1, wrong ones −1. Start with icare_wallet: it gives the agent wallet address, ' +
  'to fund with test USDC (https://faucet.circle.com, Base Sepolia). Then use icare_live_matches, icare_bet, icare_positions and icare_sell. ' +
  'Bets are paid in USDC over x402: no ETH and no gas needed. Only when ICARE access codes are on (a bet answers that activation is required), activate the wallet once with icare_activate.' })

server.registerTool('icare_wallet', { title: 'Agent wallet', description: 'Address of the agent wallet (created on this machine on first use when no key is configured), its test USDC balance, its ICARE Portfolio balance, and where to get test USDC.',
  inputSchema: {} }, async () => {
  await ensureWallet()
  const cfg = await config()
  const token = new ethers.Contract(cfg.asset, ['function balanceOf(address) view returns(uint256)'], provider)
  const funds = new ethers.Contract(cfg.funds, FUNDS_ABI, provider)
  const [walletUsdc, portfolioUsdc] = await Promise.all([token.balanceOf(wallet.address), funds.balanceOf(wallet.address)])
  return result({ address: wallet.address, network: 'Base Sepolia testnet', walletUsdc: usdc(walletUsdc), portfolioUsdc: usdc(portfolioUsdc), ethNeeded: false,
    testUsdc: 'https://faucet.circle.com: choose Base Sepolia and paste the address', keyKeptIn: ENV_KEY ? 'ICARE_AGENT_PRIVATE_KEY' : STATE })
})

server.registerTool('icare_live_matches', { title: 'Live ICARE matches', description: 'Followed live matches with Win/Lose prices, pot, closing time, and recent results with their referee proof.',
  inputSchema: { includeFinished: z.boolean().optional().describe('Also return recent settled or refunded matches') } }, async ({ includeFinished }) => {
  const { status, body } = await json(`${API}/api/observed`)
  if (status !== 200 || !Array.isArray(body)) return failure('ICARE match list unavailable, retry later.')
  const rows = body.map(summary)
  return result(includeFinished ? rows.slice(0, 40) : rows.filter(row => row.status === 'open' || row.status === 'in_progress_closed'))
})

server.registerTool('icare_activate', { title: 'Activate this agent wallet', description: `Only when ICARE access codes are on: one-time activation of the agent wallet with an access code (codes are given in the ICARE Discord: ${DISCORD}).`,
  inputSchema: { code: z.string().regex(/^[0-9]{6}$/).describe('Six-digit ICARE access code') } }, async ({ code }) => {
  await ensureWallet()
  const walletAddress = wallet.address.toLowerCase()
  const challenge = await json(`${APP}/api/early-access/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'activate', walletAddress, code }) })
  if (challenge.status !== 200 || !challenge.body?.message) return failure(`Activation refused (${challenge.body?.error || challenge.status}).`)
  const signature = await wallet.signMessage(challenge.body.message)
  const response = await fetch(`${APP}/api/invitation/verify`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, walletAddress, nonce: challenge.body.nonce, signature }), signal: AbortSignal.timeout(30_000) })
  const cookie = response.headers.getSetCookie().map(line => line.split(';')[0]).find(line => line.startsWith('icare-access-v1='))
  if (response.status !== 200 || !cookie) return failure(`Activation refused (${(await response.json().catch(() => ({}))).error || response.status}).`)
  const saved = await state()
  saved[walletAddress] = { ...(saved[walletAddress] || {}), access: cookie.slice('icare-access-v1='.length) }
  await saveState(saved)
  return result({ activated: true, wallet: walletAddress })
})

server.registerTool('icare_bet', { title: 'Predict Win or Lose', description: 'Place a Win/Lose prediction on an open match. Uses the agent Portfolio balance when it covers the stake + 0.10 USDC, otherwise pays the stake + 0.20 USDC network fees over x402 (gasless USDC authorization).',
  inputSchema: { matchId: z.string().regex(/^[1-9][0-9]{0,20}$/), side: z.enum(['win', 'lose']).describe('win = the streamer wins this game'),
    stakeUsdc: z.string().regex(/^[0-9]{1,4}(\.[0-9]{1,6})?$/).describe('Stake in USDC, 1 to 50') } }, async ({ matchId, side, stakeUsdc }) => {
  await ensureWallet()
  const cfg = await config(), stake = ethers.parseUnits(stakeUsdc, 6), outcome = side === 'win' ? 0 : 1, account = wallet.address.toLowerCase()
  if (stake < BigInt(cfg.minStake) || stake > BigInt(cfg.maxStake)) return failure(`Stake must be between ${usdc(cfg.minStake)} and ${usdc(cfg.maxStake)} USDC.`)
  // Code d'accès désactivé côté ICARE (accessRequired: false) : aucune activation, le wallet signe la mise et le paiement.
  const access = cfg.accessRequired === false ? null : await accessSession()
  const funds = new ethers.Contract(cfg.funds, FUNDS_ABI, provider)
  const [nonce, balance, block] = await Promise.all([funds.executionNonce(account), funds.balanceOf(account), provider.getBlock('latest')])
  const action = { account, target: cfg.match, value: stake.toString(), relayFee: '0', nonce: nonce.toString(), deadline: String(Number(block.timestamp) + 600),
    data: new ethers.Interface(MATCH_ABI).encodeFunctionData('placePrediction', [BigInt(matchId), outcome, stake]) }
  const signature = await wallet.signMessage(ethers.getBytes(await funds.actionDigest(action)))
  if (BigInt(balance) >= stake + 100_000n) {
    const relayed = await json(`${API}/api/funds/execute-signed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, signature }) }, 90_000)
    return relayed.status === 200 ? result({ placed: true, matchId, side, stakeUsdc, paidFrom: 'portfolio', betTx: relayed.body?.txHash })
      : failure(`Bet refused (${relayed.body?.error || relayed.status}).`)
  }
  const request = { method: 'POST', headers: { 'content-type': 'application/json', ...(access ? { 'x-icare-access': access } : {}) },
    body: JSON.stringify({ matchId, outcome, stake: stake.toString(), action, signature }) }
  const first = await json(`${API}/api/agents/bets`, request)
  if (first.status !== 402) return failure(`Bet refused (${first.body?.error || first.status}).`)
  const requirement = first.body?.accepts?.[0]
  if (!requirement || requirement.payTo?.toLowerCase() !== cfg.payTo || requirement.asset?.toLowerCase() !== cfg.asset || BigInt(requirement.amount) !== stake + BigInt(cfg.fees)) {
    return failure('Unexpected payment request, nothing was signed.')
  }
  const now = Number(block.timestamp)
  const authorization = { from: account, to: requirement.payTo, value: requirement.amount, validAfter: String(now - 10), validBefore: String(now + 240), nonce: ethers.hexlify(ethers.randomBytes(32)) }
  const paymentSignature = await wallet.signTypedData({ name: requirement.extra.name, version: requirement.extra.version, chainId: cfg.chainId, verifyingContract: requirement.asset },
    AUTHORIZATION_TYPES, authorization)
  const paid = await json(`${API}/api/agents/bets`, { ...request, headers: { ...request.headers,
    'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({ x402Version: 2, accepted: requirement, payload: { authorization, signature: paymentSignature } }) } }, 150_000)
  return paid.status === 200 ? result({ placed: true, matchId, side, stakeUsdc, paidUsdc: usdc(requirement.amount), ...paid.body })
    : failure(`Bet not placed (${paid.body?.error || paid.status}).${paid.body?.error === 'agent_bet_not_placed_funds_in_portfolio' ? ' The stake is on your ICARE Portfolio.' : ''}`)
})

server.registerTool('icare_positions', { title: 'Agent positions', description: 'Portfolio balance and Win/Lose units held on recent matches.', inputSchema: {} }, async () => {
  await ensureWallet()
  const cfg = await config(), account = wallet.address.toLowerCase()
  const balance = await new ethers.Contract(cfg.funds, FUNDS_ABI, provider).balanceOf(account)
  const { body } = await json(`${API}/api/observed`)
  const positions = []
  for (const row of (Array.isArray(body) ? body : []).slice(0, 15)) {
    const { questionId, prediction } = await market(row.matchId)
    const units = await prediction.positionsOf(questionId, account)
    if (units[0] > 0n || units[1] > 0n) positions.push({ ...summary(row), winUnits: usdc(units[0]), loseUnits: usdc(units[1]) })
  }
  return result({ wallet: account, portfolioUsdc: usdc(balance), positions })
})

server.registerTool('icare_sell', { title: 'Sell a position to ICARE liquidity', description: 'Sell Win or Lose units on an open match at the ICARE liquidity buyback price (filled within seconds when the price is offered).',
  inputSchema: { matchId: z.string().regex(/^[1-9][0-9]{0,20}$/), side: z.enum(['win', 'lose']),
    units: z.string().regex(/^[0-9]{1,4}(\.[0-9]{1,6})?$/).optional().describe('Units to sell, default all') } }, async ({ matchId, side, units }) => {
  await ensureWallet()
  const cfg = await config(), outcome = side === 'win' ? 0 : 1, account = wallet.address.toLowerCase()
  const { questionId, prediction, predictionAddress } = await market(matchId)
  const held = (await prediction.positionsOf(questionId, account))[outcome]
  const amount = units ? ethers.parseUnits(units, 6) : held
  if (amount <= 0n || amount > held) return failure(`You hold ${usdc(held)} ${side} units on match ${matchId}.`)
  const quote = await json(`${API}/api/observed/maker/quote?matchId=${matchId}&outcome=${outcome}&units=${amount}`)
  if (!quote.body?.price) return failure('No buyback price right now (market closed, exits locked or liquidity limit reached).')
  const price = BigInt(quote.body.price), [, , sellerProceeds] = await prediction.quoteTransferFees(questionId, price)
  const offer = { questionId, seller: account, outcome, units: amount.toString(), price: price.toString(), minSellerProceeds: sellerProceeds.toString(),
    nonce: ((BigInt(Date.now()) << 64n) | BigInt(ethers.hexlify(ethers.randomBytes(8)))).toString(), deadline: String(Math.floor(Date.now() / 1000) + 3_600) }
  const signature = await wallet.signTypedData({ name: 'CantorFi Prediction', version: '1', chainId: cfg.chainId, verifyingContract: predictionAddress }, OFFER_TYPES, offer)
  const published = await json(`${API}/api/index/prediction/offers`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chainId: cfg.chainId, contractAddress: predictionAddress, kind: 'mono', offer, signature }) })
  return [200, 201].includes(published.status) ? result({ offered: true, matchId, side, units: usdc(amount), priceUsdc: usdc(price), youReceiveUsdc: usdc(sellerProceeds), note: 'ICARE liquidity fills it within seconds; check icare_positions.' })
    : failure(`Offer refused (${published.body?.error || published.status}).`)
})

server.registerTool('icare_season', { title: 'Season 0 leaderboard', description: 'Season 0 standings: +1 per correct prediction, −1 per wrong one.', inputSchema: {} }, async () => {
  const { status, body } = await json(`${SEASON}?limit=10`)
  return status === 200 ? result(body?.data || body) : failure('Season 0 leaderboard unavailable.')
})

await server.connect(new StdioServerTransport())
