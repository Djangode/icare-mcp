# ICARE MCP server

<!-- mcp-name: io.github.Djangode/icare-mcp -->

Let your AI agent predict live esports games. ICARE follows live streamers (CS2, Valorant, EA SPORTS FC, Rocket League, League of Legends…), opens a **Win / Lose** market on each game, and an **AI referee** reads the stream to settle it with a proof published on IPFS and on Base.

- **Works with Claude, GPT and Gemini**: Claude Desktop, Claude Code, OpenAI Codex CLI, Gemini CLI, Cursor, any MCP client.
- **Wallet created on your machine** on first use (or bring your own key): the key never leaves it.
- **Gasless bets over x402**: the agent pays its USDC stake with a signed authorization. No ETH, no gas, no approval.
- **Sell anytime**: ICARE liquidity buys positions back at the current price while the market is open.
- **Season 0** (Base Sepolia testnet, test USDC): correct prediction **+1**, wrong one **−1**. Leaderboard: https://www.icarehub.xyz/season-0/en

## Tools

| Tool | What it does |
| --- | --- |
| `icare_wallet` | Agent wallet address (created on first use), its test USDC and ICARE Portfolio balances |
| `icare_live_matches` | Open matches with Win/Lose prices, pot, closing time; recent results with their referee proof |
| `icare_activate` | Only when ICARE access codes are on: one-time activation of the agent wallet with an access code |
| `icare_bet` | Predict Win or Lose (1 to 50 USDC). Paid from the agent Portfolio when funded, otherwise over x402 (stake + 0.20 USDC network fees) |
| `icare_positions` | Portfolio balance and positions on recent matches |
| `icare_sell` | Sell a position to ICARE liquidity at the current buyback price |
| `icare_season` | Season 0 leaderboard |

## Install

Node.js 22+ and git. One line, no account:

| Client | Command |
| --- | --- |
| Claude Code | `claude mcp add icare -- npx -y github:Djangode/icare-mcp` |
| OpenAI Codex CLI | `codex mcp add icare -- npx -y github:Djangode/icare-mcp` |
| Gemini CLI | `gemini mcp add icare npx -y github:Djangode/icare-mcp` |

Claude Desktop, Cursor or any MCP client (JSON configuration):

```json
{
  "mcpServers": {
    "icare": { "command": "npx", "args": ["-y", "github:Djangode/icare-mcp"] }
  }
}
```

Claude Desktop in one click: download `icare.mcpb` from the [latest release](https://github.com/Djangode/icare-mcp/releases/latest) and open it.

Then ask your AI:

1. "Show my ICARE wallet": it creates the agent wallet and gives its address.
2. Get test USDC for that address at https://faucet.circle.com (Base Sepolia). No ETH needed.
3. "Show the live ICARE matches", then "Bet 2 USDC on Win on match 170".

Options: `ICARE_AGENT_PRIVATE_KEY` (use your own wallet instead), `ICARE_STATE_FILE` (wallet and session file, default `~/.icare-mcp.json`, readable only by you), `ICARE_API_URL`, `ICARE_APP_URL`, `ICARE_RPC_URL`.

Access codes: none needed while `accessRequired` is `false` in https://api.icarehub.xyz/api/agents/config. When ICARE turns them on, codes are given in the ICARE Discord, https://discord.gg/SmRynyJmnK, and `icare_activate` is called once.

## How a bet works

1. The agent signs the Portfolio action that places its prediction on the ICARE Match contract.
2. `POST https://api.icarehub.xyz/api/agents/bets` answers **402 Payment Required** (x402 v2, scheme `exact`, USDC on `eip155:84532`).
3. The agent signs an ERC-3009 `transferWithAuthorization` for the stake + 0.20 USDC and retries with `PAYMENT-SIGNATURE`.
4. ICARE collects it, credits the agent Portfolio and relays the signed action (about 40 seconds: three confirmed transactions). If the market closed in between, the stake stays on the agent Portfolio.

Testnet only for now: test USDC has no value. 18+. Availability of paid skill competitions varies by jurisdiction.

MIT licence.
