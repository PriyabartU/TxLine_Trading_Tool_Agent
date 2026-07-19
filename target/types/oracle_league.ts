/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/oracle_league.json`.
 */
export type OracleLeague = {
  "address": "AJdsHnwJ4WEz3zUFdpC7duedN9Ry2mQPB2gai8AiqVku",
  "metadata": {
    "name": "oracleLeague",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Sealed League — verifiable track-record protocol for AI forecasting agents"
  },
  "instructions": [
    {
      "name": "backAgent",
      "docs": [
        "Human layer: back an agent with lamports (devnet SOL stands in for",
        "USDC in the demo build; swapping to an SPL-token vault is mechanical).",
        "Deposits buy shares of the agent's vault at its current equity, like a",
        "fund: equity = vault balance + stakes currently in flight. The vault is",
        "the agent's staking bankroll — wins grow every backer's share value,",
        "slashes shrink it. Withdrawable only via `withdraw_backing`."
      ],
      "discriminator": [
        28,
        12,
        95,
        85,
        115,
        225,
        18,
        63
      ],
      "accounts": [
        {
          "name": "agent",
          "writable": true
        },
        {
          "name": "vault",
          "docs": [
            "validated by seeds, holds no data."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              }
            ]
          }
        },
        {
          "name": "vaultState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              }
            ]
          }
        },
        {
          "name": "backerPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  99,
                  107,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              },
              {
                "kind": "account",
                "path": "backer"
              }
            ]
          }
        },
        {
          "name": "backer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "claimPayout",
      "docs": [
        "Phase 4 — CLAIM. Parimutuel payout, permissionless to crank once every",
        "commitment on the match is graded. Winners take their stake back plus",
        "a pro-rata share of the losers' stakes; losers were already slashed at",
        "settlement (their stake never leaves the pot). If nobody was right,",
        "revealed stakes are refunded to their vaults — stranding the pot would",
        "just bleed backer capital with no winner to pay it to.",
        "The spent prediction account is closed and its rent returned to the",
        "cranker, so a settled round costs only transaction fees."
      ],
      "discriminator": [
        127,
        240,
        132,
        62,
        227,
        198,
        146,
        133
      ],
      "accounts": [
        {
          "name": "agent"
        },
        {
          "name": "matchAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "match_account.match_id",
                "account": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "pot",
          "docs": [
            "lamports; validated by seeds, holds no data."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "match_account.match_id",
                "account": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "prediction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  101,
                  100,
                  105,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              },
              {
                "kind": "account",
                "path": "match_account.match_id",
                "account": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "vault",
          "docs": [
            "every backer's share value — no matter who cranks the claim."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              }
            ]
          }
        },
        {
          "name": "vaultState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              }
            ]
          }
        },
        {
          "name": "cranker",
          "docs": [
            "Claiming is permissionless — any payer may crank it (and receives the",
            "closed prediction account's rent)."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "closeMatch",
      "docs": [
        "Housekeeping: once every commitment on a match is claimed, anyone may",
        "close the match account (rent → cranker) and sweep the pot's leftover",
        "lamports (prefund + rounding dust). Keeps long-running leagues from",
        "bleeding rent into dead PDAs."
      ],
      "discriminator": [
        79,
        174,
        36,
        80,
        233,
        185,
        176,
        239
      ],
      "accounts": [
        {
          "name": "matchAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "match_account.match_id",
                "account": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "pot",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "match_account.match_id",
                "account": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "cranker",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "closeRound",
      "docs": [
        "Housekeeping: keeper reclaims a spent round account's rent once its",
        "matches are fully claimed and closed. Authority-gated because closing",
        "drops the results root this round's proofs verified against."
      ],
      "discriminator": [
        149,
        14,
        81,
        88,
        230,
        226,
        234,
        37
      ],
      "accounts": [
        {
          "name": "league",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  103,
                  117,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.round_id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "league"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "commitPrediction",
      "docs": [
        "Phase 1 — COMMIT. Stores only the hash, and locks the agent's stake",
        "into the match pot in the same transaction: skin in the game is bound",
        "to the sealed pick, so no one can size a stake after seeing a result.",
        "The clock check is the integrity core of the protocol: after",
        "`commit_deadline`, this instruction is unreachable for this match.",
        "",
        "The stake is drawn from the agent's backing vault — backer capital is",
        "the agent's ammunition, and backers ride the agent's wins and slashes",
        "pro-rata. The keeper seeds each vault as the first backer."
      ],
      "discriminator": [
        92,
        250,
        182,
        231,
        10,
        22,
        234,
        71
      ],
      "accounts": [
        {
          "name": "agent",
          "writable": true
        },
        {
          "name": "matchAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "match_account.match_id",
                "account": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "pot",
          "docs": [
            "lamports; validated by seeds, holds no data."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "match_account.match_id",
                "account": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              }
            ]
          }
        },
        {
          "name": "vaultState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              }
            ]
          }
        },
        {
          "name": "prediction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  101,
                  100,
                  105,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              },
              {
                "kind": "account",
                "path": "match_account.match_id",
                "account": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "agent"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "commitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "stake",
          "type": "u64"
        }
      ]
    },
    {
      "name": "createMatch",
      "docs": [
        "Keeper opens a match window. `commit_deadline` must precede kickoff so",
        "no prediction can be informed by in-game events."
      ],
      "discriminator": [
        107,
        2,
        184,
        145,
        70,
        142,
        17,
        165
      ],
      "accounts": [
        {
          "name": "league",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  103,
                  117,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "matchAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104
                ]
              },
              {
                "kind": "arg",
                "path": "matchId"
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "league"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "matchId",
          "type": "u64"
        },
        {
          "name": "roundId",
          "type": "u64"
        },
        {
          "name": "home",
          "type": "string"
        },
        {
          "name": "away",
          "type": "string"
        },
        {
          "name": "startTs",
          "type": "i64"
        },
        {
          "name": "commitDeadline",
          "type": "i64"
        }
      ]
    },
    {
      "name": "forfeitUnrevealed",
      "docs": [
        "Slash a no-show. Once the round's results root is on-chain, any agent",
        "that committed but never revealed can be forfeited permissionlessly:",
        "its prediction is graded incorrect and its stake stays in the pot.",
        "Without this, a silent agent could hold every honest winner's payout",
        "hostage (claims require the full match to be graded)."
      ],
      "discriminator": [
        106,
        138,
        130,
        170,
        105,
        11,
        59,
        183
      ],
      "accounts": [
        {
          "name": "agent",
          "writable": true
        },
        {
          "name": "matchAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "match_account.match_id",
                "account": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "round",
          "docs": [
            "Forfeit is only possible once results are final — the round root's",
            "existence (enforced by seed derivation) is the proof of that."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "match_account.round_id",
                "account": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "prediction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  101,
                  100,
                  105,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              },
              {
                "kind": "account",
                "path": "match_account.match_id",
                "account": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "cranker",
          "docs": [
            "Forfeiture is permissionless — any payer may crank it."
          ],
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "docs": [
        "One-time league setup. `authority` becomes the keeper identity allowed",
        "to create matches and post results roots."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "league",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  103,
                  117,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "postResultsRoot",
      "docs": [
        "Keeper posts the results Merkle root for a round.",
        "",
        ">>> PRODUCTION NOTE: this is the single trusted step in the demo build,",
        ">>> and it is exactly the step TxLINE removes. The integration replaces",
        ">>> this instruction body with a CPI into TxLINE's `validate_stat`,",
        ">>> which proves the root instead of accepting it from the keeper.",
        ">>> Nothing downstream (settlement, grading, stats) changes."
      ],
      "discriminator": [
        177,
        240,
        247,
        179,
        123,
        165,
        243,
        217
      ],
      "accounts": [
        {
          "name": "league",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  103,
                  117,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "arg",
                "path": "roundId"
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "league"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "roundId",
          "type": "u64"
        },
        {
          "name": "root",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "reconcileVault",
      "docs": [
        "Keeper-only bookkeeping repair. A round that dies mid-flight (RPC",
        "outage) strands its stakes in match pots: the lamports are gone from",
        "the vault but `staked_outstanding` still counts them, inflating equity",
        "and mis-pricing shares. This writes off stale in-flight stakes so",
        "equity reflects reality. It moves no funds and cannot touch balances —",
        "gated to the league authority."
      ],
      "discriminator": [
        155,
        3,
        193,
        142,
        152,
        183,
        87,
        196
      ],
      "accounts": [
        {
          "name": "league",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  103,
                  117,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "agent"
        },
        {
          "name": "vaultState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "league"
          ]
        }
      ],
      "args": [
        {
          "name": "stakedOutstanding",
          "type": "u64"
        }
      ]
    },
    {
      "name": "registerAgent",
      "docs": [
        "Register a forecasting agent. The agent PDA is seeded by name, so",
        "names are unique and the address is derivable by anyone auditing."
      ],
      "discriminator": [
        135,
        157,
        66,
        195,
        2,
        113,
        175,
        30
      ],
      "accounts": [
        {
          "name": "league",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  103,
                  117,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "agent",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "name"
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "strategy",
          "type": "string"
        }
      ]
    },
    {
      "name": "revealPrediction",
      "docs": [
        "Phase 2 — REVEAL. Only valid after kickoff, and only if",
        "sha256(match_id_le || pick || salt || agent_pubkey) equals the stored",
        "commitment. Binding the agent pubkey into the preimage prevents one",
        "agent replaying another agent's commitment."
      ],
      "discriminator": [
        76,
        137,
        127,
        4,
        163,
        5,
        110,
        64
      ],
      "accounts": [
        {
          "name": "agent",
          "writable": true
        },
        {
          "name": "matchAccount",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "match_account.match_id",
                "account": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "prediction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  101,
                  100,
                  105,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              },
              {
                "kind": "account",
                "path": "match_account.match_id",
                "account": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "agent"
          ]
        }
      ],
      "args": [
        {
          "name": "pick",
          "type": "u8"
        },
        {
          "name": "salt",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "settlePrediction",
      "docs": [
        "Phase 3 — SETTLE. Permissionless: anyone holding a valid Merkle proof",
        "can settle any revealed prediction. The leaf commits to the match and",
        "its result; the proof chains to the round root with sorted-pair",
        "hashing (proofs carry no index bits)."
      ],
      "discriminator": [
        201,
        129,
        177,
        154,
        16,
        155,
        48,
        41
      ],
      "accounts": [
        {
          "name": "agent",
          "writable": true
        },
        {
          "name": "matchAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "match_account.match_id",
                "account": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "round",
          "docs": [
            "The round the match belongs to — enforced by seed derivation."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "match_account.round_id",
                "account": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "prediction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  101,
                  100,
                  105,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              },
              {
                "kind": "account",
                "path": "match_account.match_id",
                "account": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "cranker",
          "docs": [
            "Settlement is permissionless — any payer may crank it."
          ],
          "signer": true
        }
      ],
      "args": [
        {
          "name": "result",
          "type": "u8"
        },
        {
          "name": "proof",
          "type": {
            "vec": {
              "array": [
                "u8",
                32
              ]
            }
          }
        }
      ]
    },
    {
      "name": "withdrawBacking",
      "docs": [
        "Withdraw backing by lamport amount: burns the shares that amount is",
        "worth at current equity (rounded up, so the vault never overpays).",
        "Only the vault's liquid balance is withdrawable — capital locked in",
        "live match pots frees up when the round's claims are cranked."
      ],
      "discriminator": [
        42,
        74,
        28,
        146,
        165,
        192,
        91,
        72
      ],
      "accounts": [
        {
          "name": "agent",
          "writable": true
        },
        {
          "name": "vault",
          "docs": [
            "validated by seeds, holds no data."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              }
            ]
          }
        },
        {
          "name": "vaultState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              }
            ]
          }
        },
        {
          "name": "backerPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  99,
                  107,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              },
              {
                "kind": "account",
                "path": "backer"
              }
            ]
          }
        },
        {
          "name": "backer",
          "writable": true,
          "signer": true,
          "relations": [
            "backerPosition"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "agent",
      "discriminator": [
        47,
        166,
        112,
        147,
        155,
        197,
        86,
        7
      ]
    },
    {
      "name": "backerPosition",
      "discriminator": [
        179,
        182,
        243,
        221,
        70,
        213,
        164,
        128
      ]
    },
    {
      "name": "league",
      "discriminator": [
        65,
        23,
        216,
        206,
        217,
        174,
        87,
        182
      ]
    },
    {
      "name": "matchAccount",
      "discriminator": [
        235,
        36,
        243,
        39,
        81,
        16,
        144,
        87
      ]
    },
    {
      "name": "prediction",
      "discriminator": [
        98,
        127,
        141,
        187,
        218,
        33,
        8,
        14
      ]
    },
    {
      "name": "round",
      "discriminator": [
        87,
        127,
        165,
        51,
        73,
        78,
        116,
        174
      ]
    },
    {
      "name": "vaultState",
      "discriminator": [
        228,
        196,
        82,
        165,
        98,
        210,
        235,
        152
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "nameTooLong",
      "msg": "Name or strategy exceeds 32 bytes"
    },
    {
      "code": 6001,
      "name": "badSchedule",
      "msg": "Commit deadline must not be after kickoff"
    },
    {
      "code": 6002,
      "name": "commitWindowClosed",
      "msg": "Commit window has closed for this match"
    },
    {
      "code": 6003,
      "name": "revealTooEarly",
      "msg": "Cannot reveal before kickoff"
    },
    {
      "code": 6004,
      "name": "alreadyRevealed",
      "msg": "Prediction already revealed"
    },
    {
      "code": 6005,
      "name": "invalidPick",
      "msg": "Pick out of range (0=home, 1=draw, 2=away)"
    },
    {
      "code": 6006,
      "name": "commitmentMismatch",
      "msg": "Reveal does not match the committed hash"
    },
    {
      "code": 6007,
      "name": "notRevealed",
      "msg": "Prediction has not been revealed"
    },
    {
      "code": 6008,
      "name": "alreadySettled",
      "msg": "Prediction already settled"
    },
    {
      "code": 6009,
      "name": "invalidProof",
      "msg": "Merkle proof does not chain to the round's results root"
    },
    {
      "code": 6010,
      "name": "insufficientBacking",
      "msg": "Withdrawal exceeds backed amount"
    },
    {
      "code": 6011,
      "name": "stakeRequired",
      "msg": "Commitments must carry a positive stake"
    },
    {
      "code": 6012,
      "name": "notSettled",
      "msg": "Prediction has not been settled"
    },
    {
      "code": 6013,
      "name": "alreadyClaimed",
      "msg": "Payout already claimed for this prediction"
    },
    {
      "code": 6014,
      "name": "notAllGraded",
      "msg": "Match still has ungraded commitments"
    },
    {
      "code": 6015,
      "name": "vaultInsufficient",
      "msg": "Vault has insufficient liquid funds for this amount"
    }
  ],
  "types": [
    {
      "name": "agent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "strategy",
            "type": "string"
          },
          {
            "name": "commits",
            "docs": [
              "The verifiable record. Monotonic; only mutated by the instructions above."
            ],
            "type": "u64"
          },
          {
            "name": "reveals",
            "type": "u64"
          },
          {
            "name": "settled",
            "type": "u64"
          },
          {
            "name": "correct",
            "type": "u64"
          },
          {
            "name": "totalBacked",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "backerPosition",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "backer",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "docs": [
              "Vault shares, not lamports: value = shares × equity / total_shares."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "league",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "agents",
            "type": "u64"
          },
          {
            "name": "matches",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "matchAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "matchId",
            "type": "u64"
          },
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "home",
            "type": "string"
          },
          {
            "name": "away",
            "type": "string"
          },
          {
            "name": "startTs",
            "type": "i64"
          },
          {
            "name": "commitDeadline",
            "type": "i64"
          },
          {
            "name": "stakedTotal",
            "docs": [
              "Parimutuel bookkeeping: lamports locked in the pot, how many",
              "commitments exist, how many are graded/claimed, and the correct-side",
              "stake."
            ],
            "type": "u64"
          },
          {
            "name": "commitCount",
            "type": "u64"
          },
          {
            "name": "gradedCount",
            "type": "u64"
          },
          {
            "name": "winningStake",
            "type": "u64"
          },
          {
            "name": "paidCount",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "prediction",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "matchId",
            "type": "u64"
          },
          {
            "name": "commitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "committedAt",
            "type": "i64"
          },
          {
            "name": "revealed",
            "type": "bool"
          },
          {
            "name": "pick",
            "type": "u8"
          },
          {
            "name": "salt",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "revealedAt",
            "type": "i64"
          },
          {
            "name": "settled",
            "type": "bool"
          },
          {
            "name": "result",
            "type": "u8"
          },
          {
            "name": "correct",
            "type": "bool"
          },
          {
            "name": "settledAt",
            "type": "i64"
          },
          {
            "name": "stake",
            "docs": [
              "Lamports locked at commit time; released or slashed by `claim_payout`."
            ],
            "type": "u64"
          },
          {
            "name": "paidOut",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "round",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "resultsRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "postedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "vaultState",
      "docs": [
        "Per-agent vault bookkeeping. `staked_outstanding` counts lamports the vault",
        "has locked into live match pots — part of equity, but not yet withdrawable."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "totalShares",
            "type": "u64"
          },
          {
            "name": "stakedOutstanding",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
