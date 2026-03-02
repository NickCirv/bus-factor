# bus-factor

> Calculate your codebase's bus factor. Find single points of failure. Know who's holding everything together.

**Bus factor** = the minimum number of team members who, if suddenly unavailable, would halt the project. Named after the grim question: "How many people need to be hit by a bus before this project is dead?"

Zero dependencies. Pure Node.js. Works entirely offline via git history.

## Install & Run

```bash
# Run immediately with npx (no install needed)
npx bus-factor

# Or install globally
npm install -g bus-factor
bus-factor
```

## Example Output

```
🚌 Bus Factor Analysis
──────────────────────────────────────────────────
Repository:     my-app
Contributors:   4 (alice@acme.com, bob@acme.com, carol@acme.com, dan@acme.com)
Files analyzed: 147

Overall Bus Factor: 2
(2 people leaving would halt this project)

⚠️  Single Points of Failure:

  alice@acme.com
  Owns: 67 files (45.6% of codebase)
  Critical: src/auth, src/payments, src/core
  Impact if gone: Project effectively dead

  bob@acme.com
  Owns: 38 files (25.9%)
  Critical: src/api, config
  Impact if gone: Severe degradation

🗂️  Ownership Map:

  src/auth       ████████████████ 100% alice  🔴 BF:1
  src/payments   ████████████████ 100% alice  🔴 BF:1
  src/api        ██████████░░░░░░  60% bob    🟡 BF:1
  src/components ████░░░░░░░░░░░░  28% carol  🟢 BF:3
  tests          ████████░░░░░░░░  50% dan    🟡 BF:2
  config         ██████████████░░  88% bob    🔴 BF:1

📊 Orphan Files (only 1 contributor ever): 52

  src/auth/jwt.js           — alice only
  src/auth/session.js       — alice only
  src/payments/stripe.js    — alice only
  src/payments/webhooks.js  — alice only
  src/core/pipeline.js      — alice only
  [+47 more — use --top 60 to see all]

💡 Recommendations:

  1. Bus factor is CRITICAL (1). This project dies with one person leaving.
  2. Pair program alice on src/auth and src/payments immediately
  3. Document src/auth/ before alice's next absence
  4. Pair program bob on src/api and config immediately
  5. Target bus factor > 2 — aim for cross-training in the next sprint
```

## Commands

```bash
# Full analysis (default)
bus-factor

# What happens if one person leaves?
bus-factor --contributor alice@acme.com

# Show top 30 most at-risk files (default: 20)
bus-factor --top 30

# Analyze a specific directory
bus-factor --dir src/

# Custom ownership threshold (default: 0.5 = needs >50% of commits to be "owner")
bus-factor --threshold 0.4

# Custom SPOF threshold (default: 0.3 = owning >30% of codebase = SPOF)
bus-factor --spof-threshold 0.25

# No color output (for CI/scripts)
bus-factor --no-color
```

## How It Works

### Single-Pass Git Analysis

Instead of running `git log` per file (slow for large repos), `bus-factor` makes **one git log call** and builds the entire ownership map in memory:

```
git log --format=%x00%ae%x00 --name-only --diff-filter=ACDMR --no-merges
```

This returns all commits with their changed files in one pass. Memory-efficient. Fast on repos with 10,000+ files.

### Ownership Rules

- **File owner** = author with >`--threshold` (default 50%) of commits to that file
- **Orphan file** = only 1 person has ever committed to it (bus factor 1 regardless)
- **Fragile file** = 2–3 contributors total
- **Robust file** = 4+ contributors

### Bus Factor Calculation

Overall bus factor uses a greedy coverage algorithm:

1. Sort contributors by files owned (descending)
2. Remove them one by one
3. Stop when removed contributors owned >20% of the codebase
4. That removal count = bus factor

### Directory Rollup

Each directory's bus factor = number of unique authors who own files within it. Color coding:

- 🔴 BF:1 — one person owns this directory
- 🟡 BF:2 — two people share ownership
- 🟢 BF:3+ — knowledge is distributed

## Requirements

- Node.js >= 18
- Git installed and available in PATH
- Run from inside a git repository

## No Dependencies

Uses only Node.js built-ins: `child_process`, `fs`, `path`, `os`. Nothing to install, nothing to audit, nothing to break.

## License

MIT
