# Relay Harness historical optimization record — 10 multiagent rounds (2026-09-03)

English | [中文](README.zh.md)

This directory records 10 multiagent optimization rounds on `feat/relay-focus-frontend`, orchestrated as workflows with 78 subagents in total. Round reports live here; the corresponding `.json` files contain structured audit data. Test conclusions below describe that historical run, not the current working tree or CI status.

| Round | Topic | Output |
|---|---|---|
| R1 | Repository audit slices | 11 slices / 104 findings / TOP-25 backlog (`round-1-audit.{md,json}`) |
| R2 | Frontend and Lyra audit | Lyra mechanism catalog and a six-slice R3 plan (`round-2-frontend-audit.json`) |
| R3 | Frontend implementation | Locale consolidation / input-shell lifetime / projectList identity guards / ChatView rendering window / shared motion vocabulary; R3-A declined with evidence |
| R4 | Adversarial backend audit | 15 verdicts, including one refuted finding; three deeper investigations and a ten-slice R5 plan |
| R5 | Backend implementation | Hook loop guards / bounded FrameQueue / TS and Python SDK session cleanup / job retention / SQLite grouping / lock recovery / persistence teardown / spill degradation / desktop configuration isolation and port ownership |
| R6 | Integration audit | 12 findings, including the confirmed R5-B regression and corrected attribution |
| R7 | Integration implementation | Reconnect refresh / session.prompt alignment, removing a dead contract and adding cancellation and idempotency / submission-pipeline consistency / SDK closeSession ordering / close-wire coverage / Python races / projection-frame hygiene |
| R8 | Test additions and fixes | readWebSocket coverage / empty enter / CircuitBreaker accounting / three-inventory consistency checks / knip .tsx / SDK re-prompt resume / dead branding assertion |
| R9 | Documentation | 1235 consistent bilingual pairs / client package READMEs 59/59 / R1 documentation gaps closed |
| R10 | Full regression | That round reported passing typecheck/lint/build/test, with 17431 tests |

The recorded run made no commits, following its instruction not to create commits without authorization. Its protected layers—conversation-nodes folding, input-machine semantics, slot-registry structure, wire contracts, and ARIA semantics—were not changed. Implementing agents rejected three out-of-scope or incorrectly premised plans, R3-A/R7-A/R8-E, with evidence and Agent Notes.
