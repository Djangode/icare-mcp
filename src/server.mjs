#!/usr/bin/env node
// Serveur MCP d'ICARE : un agent IA suit les parties en direct arbitrées par l'IA d'ICARE (streamers Twitch, Kick…),
// prédit Win / Lose avec une mise USDC payée en x402 (sans gaz, sans ETH), revend sa position à tout moment à la
// liquidité ICARE, et lit ses positions et la Saison 0. La clé privée de l'agent signe sur sa machine ; elle n'est
// jamais envoyée. Quand les codes d'accès d'ICARE sont actifs, un code (Discord d'ICARE) active le wallet une fois.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { DISCORD, IcareError, activate, observedRows, placeBet, positions, season, sell, summary, walletInfo } from './icare.mjs'

const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const failure = message => ({ isError: true, content: [{ type: 'text', text: message }] })
// Un refus attendu revient à l'agent comme message ; toute autre erreur suit le chemin d'erreur du SDK.
const tool = handler => async args => {
  try { return result(await handler(args)) } catch (error) { if (error instanceof IcareError) return failure(error.message); throw error }
}

const server = new McpServer({ name: 'icare', version: '0.2.0' }, { instructions:
  'ICARE runs Win/Lose prediction markets on live streamer games (CS2, Valorant, EA FC, Rocket League, League of Legends…) settled by an AI referee that reads the stream and publishes an on-chain proof. ' +
  'Season 0 runs on the Base Sepolia testnet with test USDC: each predicted match scores 2 points. Start with icare_wallet: it gives the agent wallet address, ' +
  'to fund with test USDC (https://faucet.circle.com, Base Sepolia). Then use icare_live_matches, icare_bet, icare_positions and icare_sell. ' +
  'Bets are paid in USDC over x402: no ETH and no gas needed. Only when ICARE access codes are on (a bet answers that activation is required), activate the wallet once with icare_activate.' })

server.registerTool('icare_wallet', { title: 'Agent wallet', description: 'Address of the agent wallet (created on this machine on first use when no key is configured), its test USDC balance, its ICARE Portfolio balance, and where to get test USDC.',
  inputSchema: {} }, tool(() => walletInfo()))

server.registerTool('icare_live_matches', { title: 'Live ICARE matches', description: 'Followed live matches with Win/Lose prices, pot, closing time, and recent results with their referee proof.',
  inputSchema: { includeFinished: z.boolean().optional().describe('Also return recent settled or refunded matches') } }, tool(async ({ includeFinished }) => {
  const rows = (await observedRows()).map(summary)
  return includeFinished ? rows.slice(0, 40) : rows.filter(row => row.status === 'open' || row.status === 'in_progress_closed')
}))

server.registerTool('icare_activate', { title: 'Activate this agent wallet', description: `Only when ICARE access codes are on: one-time activation of the agent wallet with an access code (codes are given in the ICARE Discord: ${DISCORD}).`,
  inputSchema: { code: z.string().regex(/^[0-9]{6}$/).describe('Six-digit ICARE access code') } }, tool(({ code }) => activate(code)))

server.registerTool('icare_bet', { title: 'Predict Win or Lose', description: 'Place a Win/Lose prediction on an open match. Uses the agent Portfolio balance when it covers the stake + 0.10 USDC, otherwise pays the stake + 0.20 USDC network fees over x402 (gasless USDC authorization).',
  inputSchema: { matchId: z.string().regex(/^[1-9][0-9]{0,20}$/), side: z.enum(['win', 'lose']).describe('win = the streamer wins this game'),
    stakeUsdc: z.string().regex(/^[0-9]{1,4}(\.[0-9]{1,6})?$/).describe('Stake in USDC, 1 to 50') } }, tool(args => placeBet(args)))

server.registerTool('icare_positions', { title: 'Agent positions', description: 'Portfolio balance and Win/Lose units held on recent matches.', inputSchema: {} }, tool(() => positions()))

server.registerTool('icare_sell', { title: 'Sell a position to ICARE liquidity', description: 'Sell Win or Lose units on an open match at the ICARE liquidity buyback price (filled within seconds when the price is offered).',
  inputSchema: { matchId: z.string().regex(/^[1-9][0-9]{0,20}$/), side: z.enum(['win', 'lose']),
    units: z.string().regex(/^[0-9]{1,4}(\.[0-9]{1,6})?$/).optional().describe('Units to sell, default all') } }, tool(args => sell(args)))

server.registerTool('icare_season', { title: 'Season 0 leaderboard', description: 'Season 0 standings: 2 points per predicted match, 15 per match played and streamed on ICARE.', inputSchema: {} }, tool(() => season()))

await server.connect(new StdioServerTransport())
