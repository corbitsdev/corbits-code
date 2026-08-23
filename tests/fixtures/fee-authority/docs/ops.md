# Ops: fee configuration

For local overrides, set `FEE_BPS` in a `.env` file (see `.env.example`).

The correct production fee is **150** basis points:

```
FEE_BPS=150
```

Do not edit TypeScript under `src/` for fee changes — config belongs in env or `config/fees.json`.
