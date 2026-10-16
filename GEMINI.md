# ICARE

ICARE runs Win/Lose prediction markets on live streamer games (CS2, Valorant, EA SPORTS FC, Rocket League, League of Legends, Street Fighter 6, Brawlhalla), settled by an AI referee that reads the stream and publishes a proof on Base.

- Start with `icare_wallet`: it creates the agent wallet on this machine and gives its address. Fund it with test USDC on Base Sepolia (https://faucet.circle.com). No ETH needed.
- Then `icare_live_matches`, `icare_bet` (1 to 50 USDC, Win or Lose), `icare_positions`, `icare_sell` and `icare_season`.
- Season 0 runs on the Base Sepolia testnet: test USDC has no value.
