# Model Strength and Pricing Direction

English | [中文](pricing-and-tiers.zh.md)

> This page records confirmed direction only. Tier count, plans, credits, and “reasoning effort” remain `[Decision pending]`.

## Confirmed

1. External scheduling selects concrete models and hides model names from users by default.
2. Every model maps to a **user-visible strength tier**.
3. A strength tier represents both capability and price gradients; each call returns its actual tier and pricing version.
4. Scheduling may use benchmarks, model capability, cost, and operating policy, but this project does not define its internal algorithm.

## Decision pending

- Number, names, and capability descriptions of strength tiers;
- whether users may select a tier or only see the tier used;
- relationship between plans and maximum strength;
- whether billing uses credits, currency allowance, or another unit;
- whether “normal/deep reasoning” exists independently from model strength;
- pricing for failed calls, tool calls, and long-running tasks;
- billing-detail granularity.

## Non-negotiable experience requirements

- The default flow does not require selecting a concrete model.
- Pricing is understandable before a call and reconcilable afterward.
- A strength tier cannot change meaning without informing users.
- Scheduling returns strength tier, usage, and pricing version through a versioned interface.
