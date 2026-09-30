# Additional agent model catalogs

Checked on 2026-09-29. No prompts or paid turns were sent.

- Pi: `pi --list-models`, six-column provider/model table; thinking only on
  rows marked `yes`. Qualified model IDs use `--model`; effort uses `--thinking`.
  The conservative levels follow the reference parser (off, low, medium, high,
  xhigh). [CLI documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).
- Cursor: `cursor-agent --list-models`, `id - label` rows. Existing seed option
  mappings remain; new IDs get no guessed effort suffixes.
- Antigravity: `agy models`, current `id<TAB>label` rows only. The old human-name
  format is deliberately ignored to preserve strict shell-safe model values.
- Amp: reference fixed modes smart/rush/large/deep, `--mode`; `--effort` only on
  large/deep. Availability and these flags could not be checked locally.
- Kimi: installed `kimi --help` confirms `-m`/`--model`, but does not advertise
  thinking/effort flags, so those controls are omitted. The reference managed
  model `kimi-code/kimi-for-coding` (Kimi K2.6) remains a seed; its availability
  depends on the user's config/account and was not tested with a prompt.
- Copilot: installed 1.0.89 help confirms `--model` and `--reasoning-effort`.
  The fixed reference model list and GPT-5 effort range are conservative seeds,
  not an account entitlement check. Both effort aliases override the picker,
  as documented in the [CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).

Pi, Cursor, Antigravity and Amp were absent from PATH. Their probe formats and
flags are covered by synthetic fixtures derived from the reference sources,
not represented as recordings of locally installed CLIs. No unverified
mid-session command is added for Amp or Kimi. Untouched pickers add no flags.

Reference implementation: Orca shared model parsers and agent specifications,
MIT, Copyright (c) 2026 Lovecast Inc.; attribution also appears in the code.
