// Fonctions communes du serveur MCP et de l'agent autonome d'ICARE : wallet de l'agent, parties suivies, mise Win / Lose
// payée par le Portfolio ou en x402 (sans gaz, sans ETH), positions, revente à la liquidité ICARE et Saison 0.
// La clé privée de l'agent signe sur sa machine ; elle n'est jamais envoyée.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ethers } from 'ethers'
import { encodePaymentSignatureHeader } from '@x402/core/http'

export const API = (process.env.ICARE_API_URL || 'https://api.icarehub.xyz').replace(/\/+$/, '')
export const APP = (process.env.ICARE_APP_URL || 'https://app.icarehub.xyz').replace(/\/+$/, '')
const SEASON = process.env.ICARE_SEASON_URL || 'https://superdash-api.icarehub.xyz/api/indexed/icare/season0'
const RPC = process.env.ICARE_RPC_URL || 'https://sepolia.base.org'
export const STATE = process.env.ICARE_STATE_FILE || path.join(os.homedir(), '.icare-mcp.json')
export const DISCORD = 'https://discord.gg/SmRynyJmnK'
const provider = new ethers.JsonRpcProvider(RPC)
const ENV_KEY = /^(0x)?[0-9a-fA-F]{64}$/.test(process.env.ICARE_AGENT_PRIVATE_KEY || '') ? process.env.ICARE_AGENT_PRIVATE_KEY : null
let wallet = ENV_KEY ? new ethers.Wallet(ENV_KEY, provider) : null
const MATCH_ABI = ['function marketId(uint256) view returns(bytes32)', 'function predictionFor(uint256) view returns(address)',
  'function placePrediction(uint256,uint8,uint256)']
const FUNDS_ABI = ['function executionNonce(address) view returns(uint256)', 'function balanceOf(address) view returns(uint256)',
  'function actionDigest((address account,address target,uint256 value,uint256 relayFee,uint256 nonce,uint64 deadline,bytes data)) view returns(bytes32)']
const PREDICTION_ABI = ['function positionsOf(bytes32,address) view returns(uint256[4])',
  'function quoteTransferFees(bytes32,uint256) view returns(uint256 appFee,uint256 protocolFee,uint256 sellerProceeds)',
  'function claimable(bytes32,address) view returns(uint256)', 'function claimed(bytes32,address) view returns(bool)',
  'event Claimed(bytes32 indexed questionId, address indexed beneficiary, uint256 payout)']
// Le RPC public de Base Sepolia limite eth_getLogs à 200 blocs par requête.
const LOG_RANGE = 200
const OFFER_TYPES = { PositionOffer: [{ name: 'questionId', type: 'bytes32' }, { name: 'seller', type: 'address' }, { name: 'outcome', type: 'uint8' },
  { name: 'units', type: 'uint256' }, { name: 'price', type: 'uint256' }, { name: 'minSellerProceeds', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }] }
const AUTHORIZATION_TYPES = { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }

export const usdc = units => ethers.formatUnits(units, 6)
// Refus attendu (mise hors limites, partie fermée…) : le message est rendu tel quel à l'agent.
export class IcareError extends Error {}

// Comme le CLI de MoonPay : sans clé fournie, le wallet de l'agent est créé sur cette machine au premier usage et gardé
// dans le fichier d'état (droits 600) ; la clé n'en sort jamais.
let walletPromise = null
export const ensureWallet = () => walletPromise ||= (async () => {
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
export const config = () => (configPromise ||= json(`${API}/api/agents/config`).then(({ status, body }) => {
  if (status !== 200 || !body?.match) { configPromise = null; throw new IcareError('ICARE agent API unavailable, retry later.') }
  return body
}))
async function accessSession() {
  const saved = (await state())[wallet.address.toLowerCase()]?.access
  const value = process.env.ICARE_ACCESS_SESSION || saved
  if (!value) throw new IcareError(`This wallet is not activated. Get an access code in the ICARE Discord (${DISCORD}) and call icare_activate.`)
  return value
}
export function summary(row) {
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

export async function walletInfo() {
  await ensureWallet()
  const cfg = await config()
  const token = new ethers.Contract(cfg.asset, ['function balanceOf(address) view returns(uint256)'], provider)
  const funds = new ethers.Contract(cfg.funds, FUNDS_ABI, provider)
  const [walletUsdc, portfolioUsdc] = await Promise.all([token.balanceOf(wallet.address), funds.balanceOf(wallet.address)])
  return { address: wallet.address, network: 'Base Sepolia testnet', walletUsdc: usdc(walletUsdc), portfolioUsdc: usdc(portfolioUsdc), ethNeeded: false,
    testUsdc: 'https://faucet.circle.com: choose Base Sepolia and paste the address', keyKeptIn: ENV_KEY ? 'ICARE_AGENT_PRIVATE_KEY' : STATE }
}

// Parties suivies brutes (en cours et récentes), telles que les publie l'Oracle.
export async function observedRows() {
  const { status, body } = await json(`${API}/api/observed`)
  if (status !== 200 || !Array.isArray(body)) throw new IcareError('ICARE match list unavailable, retry later.')
  return body
}

export async function activate(code) {
  await ensureWallet()
  const walletAddress = wallet.address.toLowerCase()
  const challenge = await json(`${APP}/api/early-access/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'activate', walletAddress, code }) })
  if (challenge.status !== 200 || !challenge.body?.message) throw new IcareError(`Activation refused (${challenge.body?.error || challenge.status}).`)
  const signature = await wallet.signMessage(challenge.body.message)
  const response = await fetch(`${APP}/api/invitation/verify`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, walletAddress, nonce: challenge.body.nonce, signature }), signal: AbortSignal.timeout(30_000) })
  const cookie = response.headers.getSetCookie().map(line => line.split(';')[0]).find(line => line.startsWith('icare-access-v1='))
  if (response.status !== 200 || !cookie) throw new IcareError(`Activation refused (${(await response.json().catch(() => ({}))).error || response.status}).`)
  const saved = await state()
  saved[walletAddress] = { ...(saved[walletAddress] || {}), access: cookie.slice('icare-access-v1='.length) }
  await saveState(saved)
  return { activated: true, wallet: walletAddress }
}

export async function placeBet({ matchId, side, stakeUsdc }) {
  await ensureWallet()
  const cfg = await config(), stake = ethers.parseUnits(stakeUsdc, 6), outcome = side === 'win' ? 0 : 1, account = wallet.address.toLowerCase()
  if (stake < BigInt(cfg.minStake) || stake > BigInt(cfg.maxStake)) throw new IcareError(`Stake must be between ${usdc(cfg.minStake)} and ${usdc(cfg.maxStake)} USDC.`)
  // Code d'accès désactivé côté ICARE (accessRequired: false) : aucune activation, le wallet signe la mise et le paiement.
  const access = cfg.accessRequired === false ? null : await accessSession()
  const funds = new ethers.Contract(cfg.funds, FUNDS_ABI, provider)
  const [nonce, balance, block] = await Promise.all([funds.executionNonce(account), funds.balanceOf(account), provider.getBlock('latest')])
  const action = { account, target: cfg.match, value: stake.toString(), relayFee: '0', nonce: nonce.toString(), deadline: String(Number(block.timestamp) + 600),
    data: new ethers.Interface(MATCH_ABI).encodeFunctionData('placePrediction', [BigInt(matchId), outcome, stake]) }
  const signature = await wallet.signMessage(ethers.getBytes(await funds.actionDigest(action)))
  if (BigInt(balance) >= stake + 100_000n) {
    const relayed = await json(`${API}/api/funds/execute-signed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, signature }) }, 90_000)
    if (relayed.status !== 200) throw new IcareError(`Bet refused (${relayed.body?.error || relayed.status}).`)
    return { placed: true, matchId, side, stakeUsdc, paidFrom: 'portfolio', betTx: relayed.body?.txHash }
  }
  const request = { method: 'POST', headers: { 'content-type': 'application/json', ...(access ? { 'x-icare-access': access } : {}) },
    body: JSON.stringify({ matchId, outcome, stake: stake.toString(), action, signature }) }
  const first = await json(`${API}/api/agents/bets`, request)
  if (first.status !== 402) throw new IcareError(`Bet refused (${first.body?.error || first.status}).`)
  const requirement = first.body?.accepts?.[0]
  if (!requirement || requirement.payTo?.toLowerCase() !== cfg.payTo || requirement.asset?.toLowerCase() !== cfg.asset || BigInt(requirement.amount) !== stake + BigInt(cfg.fees)) {
    throw new IcareError('Unexpected payment request, nothing was signed.')
  }
  const now = Number(block.timestamp)
  const authorization = { from: account, to: requirement.payTo, value: requirement.amount, validAfter: String(now - 10), validBefore: String(now + 240), nonce: ethers.hexlify(ethers.randomBytes(32)) }
  const paymentSignature = await wallet.signTypedData({ name: requirement.extra.name, version: requirement.extra.version, chainId: cfg.chainId, verifyingContract: requirement.asset },
    AUTHORIZATION_TYPES, authorization)
  const paid = await json(`${API}/api/agents/bets`, { ...request, headers: { ...request.headers,
    'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({ x402Version: 2, accepted: requirement, payload: { authorization, signature: paymentSignature } }) } }, 150_000)
  if (paid.status !== 200) {
    throw new IcareError(`Bet not placed (${paid.body?.error || paid.status}).${paid.body?.error === 'agent_bet_not_placed_funds_in_portfolio' ? ' The stake is on your ICARE Portfolio.' : ''}`)
  }
  return { placed: true, matchId, side, stakeUsdc, paidUsdc: usdc(requirement.amount), ...paid.body }
}

// Unités Win / Lose tenues par l'agent sur une partie.
export async function unitsHeld(matchId) {
  await ensureWallet()
  const { questionId, prediction } = await market(matchId)
  const units = await prediction.positionsOf(questionId, wallet.address.toLowerCase())
  return { win: units[0], lose: units[1] }
}

export const latestBlock = () => provider.getBlockNumber()

// Gain réel d'une partie réglée (part de la cagnotte, pas le nombre d'unités) : encore à réclamer, ou déjà versé au
// Portfolio par ICARE. Le montant versé est lu dans l'événement Claimed, en remontant depuis le dernier bloc par
// tranches de 200 jusqu'au bloc de la mise (50 tranches au plus) ; payout null = versé, montant non retrouvé.
export async function payoutOf(matchId, fromBlock) {
  await ensureWallet()
  const account = wallet.address.toLowerCase()
  const { questionId, prediction } = await market(matchId)
  const pending = await prediction.claimable(questionId, account)
  if (pending > 0n) return { payout: pending, credited: false }
  if (!(await prediction.claimed(questionId, account))) return { payout: 0n, credited: false }
  const latest = await provider.getBlockNumber()
  for (let to = latest; to >= fromBlock && latest - to < 50 * LOG_RANGE; to -= LOG_RANGE) {
    const events = await prediction.queryFilter(prediction.filters.Claimed(questionId, account), Math.max(fromBlock, to - LOG_RANGE + 1), to)
    if (events.length) return { payout: events.reduce((sum, event) => sum + event.args.payout, 0n), credited: true }
  }
  return { payout: null, credited: true }
}

export async function positions() {
  await ensureWallet()
  const cfg = await config(), account = wallet.address.toLowerCase()
  const balance = await new ethers.Contract(cfg.funds, FUNDS_ABI, provider).balanceOf(account)
  const rows = await observedRows().catch(() => [])
  const held = []
  for (const row of rows.slice(0, 15)) {
    const units = await unitsHeld(row.matchId)
    if (units.win > 0n || units.lose > 0n) held.push({ ...summary(row), winUnits: usdc(units.win), loseUnits: usdc(units.lose) })
  }
  return { wallet: account, portfolioUsdc: usdc(balance), positions: held }
}

// Prix de rachat proposé par la liquidité ICARE pour des unités tenues (null quand aucun prix n'est offert).
export async function sellQuote({ matchId, side, units }) {
  await ensureWallet()
  const outcome = side === 'win' ? 0 : 1, account = wallet.address.toLowerCase()
  const { questionId, prediction, predictionAddress } = await market(matchId)
  const held = (await prediction.positionsOf(questionId, account))[outcome]
  const amount = units ? ethers.parseUnits(units, 6) : held
  if (amount <= 0n || amount > held) throw new IcareError(`You hold ${usdc(held)} ${side} units on match ${matchId}.`)
  const quote = await json(`${API}/api/observed/maker/quote?matchId=${matchId}&outcome=${outcome}&units=${amount}`)
  if (!quote.body?.price) return null
  const price = BigInt(quote.body.price), [, , sellerProceeds] = await prediction.quoteTransferFees(questionId, price)
  return { matchId, side, outcome, amount, price, sellerProceeds, questionId, predictionAddress }
}

export async function sell({ matchId, side, units }) {
  const quote = await sellQuote({ matchId, side, units })
  if (!quote) throw new IcareError('No buyback price right now (market closed, exits locked or liquidity limit reached).')
  const cfg = await config(), account = wallet.address.toLowerCase()
  const offer = { questionId: quote.questionId, seller: account, outcome: quote.outcome, units: quote.amount.toString(), price: quote.price.toString(), minSellerProceeds: quote.sellerProceeds.toString(),
    nonce: ((BigInt(Date.now()) << 64n) | BigInt(ethers.hexlify(ethers.randomBytes(8)))).toString(), deadline: String(Math.floor(Date.now() / 1000) + 3_600) }
  const signature = await wallet.signTypedData({ name: 'CantorFi Prediction', version: '1', chainId: cfg.chainId, verifyingContract: quote.predictionAddress }, OFFER_TYPES, offer)
  const published = await json(`${API}/api/index/prediction/offers`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chainId: cfg.chainId, contractAddress: quote.predictionAddress, kind: 'mono', offer, signature }) })
  if (![200, 201].includes(published.status)) throw new IcareError(`Offer refused (${published.body?.error || published.status}).`)
  return { offered: true, matchId, side, units: usdc(quote.amount), priceUsdc: usdc(quote.price), youReceiveUsdc: usdc(quote.sellerProceeds), note: 'ICARE liquidity fills it within seconds; check icare_positions.' }
}

export async function season() {
  const { status, body } = await json(`${SEASON}?limit=10`)
  if (status !== 200) throw new IcareError('Season 0 leaderboard unavailable.')
  return body?.data || body
}
