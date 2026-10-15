# @sdillen/pi-brave-search

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that adds a web search tool backed by the Brave "LLM Context" API. Results are pre-extracted, LLM-optimized snippets (text, tables, code) with source and date, so no scraping is needed.

## Install

```sh
pi install npm:@sdillen/pi-brave-search
```

Try it for a single run:

```sh
pi -e npm:@sdillen/pi-brave-search
```

## API key

Lookup order:

1. macOS Keychain (service `pi-brave-search`)
2. `BRAVE_API_KEY` environment variable
3. `~/.config/brave/api-key`

Get a key at https://api-dashboard.search.brave.com. The key never leaves your machine and is never written to the LLM context.

Slash commands:

- `/brave-key status|set|delete`: `set` reads the clipboard.
- `/brave-test`: checks the key and the endpoint.

If the key is missing on a call, pi asks whether to store the clipboard contents in the Keychain.

## Robustness

Rate limiting (429) and 5xx responses are retried with backoff, up to 3 times. The timeout is 30 s. If a result exceeds the token budget, it is truncated and the full output is written to a temp file, whose path is included in the result.

Full architecture notes and the development setup are in the [repository README](https://github.com/sdillen/pi-extensions#readme).

## License

[MIT](LICENSE)
