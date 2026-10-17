# Dispatch routing eval

```sh
bun scripts/eval-prompts-dispatch.ts
# or
bun run eval:prompts-dispatch
```

Local Ollama by default. Override with `EVAL_OLLAMA_URL` and `EVAL_MODEL`:

```sh
EVAL_MODEL=tev1:0.8b bun scripts/eval-prompts-dispatch.ts
EVAL_OLLAMA_URL=http://localhost:11434 EVAL_MODEL=qwen3:0.6b bun scripts/eval-prompts-dispatch.ts
```
