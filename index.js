#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { resolve, dirname, relative, sep } from 'path';
import { existsSync } from 'fs';

// ─── CLI Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag, defaultVal = null) {
  const idx = args.indexOf(flag);
  if (idx === -1) return defaultVal;
  return args[idx + 1] ?? defaultVal;
}

function hasFlag(flag) {
  return args.includes(flag);
}

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`
bus-factor — Calculate your codebase's bus factor

USAGE
  bus-factor [options]

OPTIONS
  --contributor <email>   Simulate what happens if one person leaves
  --top <n>               Show top N most at-risk files (default: 20)
  --dir <path>            Analyze a specific directory only
  --threshold <0-1>       Ownership threshold (default: 0.5 = 50%)
  --spof-threshold <0-1>  SPOF threshold (default: 0.3 = 30%)
  --no-color              Disable colored output
  --help                  Show this help

EXAMPLES
  bus-factor
  bus-factor --contributor alice@example.com
  bus-factor --top 30
  bus-factor --dir src/
  bus-factor --threshold 0.4
`);
  process.exit(0);
}

const contributorFilter = getArg('--contributor');
const topN = parseInt(getArg('--top', '20'), 10);
const dirFilter = getArg('--dir');
const ownerThreshold = parseFloat(getArg('--threshold', '0.5'));
const spofThreshold = parseFloat(getArg('--spof-threshold', '0.3'));
const noColor = hasFlag('--no-color') || !process.stdout.isTTY;

// ─── Colors ──────────────────────────────────────────────────────────────────

const c = noColor ? {
  red: s => s, yellow: s => s, green: s => s,
  bold: s => s, dim: s => s, cyan: s => s, magenta: s => s,
  reset: '',
} : {
  red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  magenta: s => `\x1b[35m${s}\x1b[0m`,
  reset: '\x1b[0m',
};

// ─── Git helpers ─────────────────────────────────────────────────────────────

function git(...gitArgs) {
  try {
    return execFileSync('git', gitArgs, {
      encoding: 'utf8',
      maxBuffer: 200 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    return '';
  }
}

function assertGitRepo() {
  const result = git('rev-parse', '--is-inside-work-tree');
  if (result !== 'true') {
    console.error(c.red('Error: Not inside a git repository.'));
    process.exit(1);
  }
}

function getRepoRoot() {
  return git('rev-parse', '--show-toplevel');
}

function getRepoName() {
  const remote = git('remote', 'get-url', 'origin');
  if (remote) {
    const match = remote.match(/([^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  }
  return resolve('.').split(sep).pop();
}

// ─── Core analysis — single-pass git log ─────────────────────────────────────

/**
 * Build ownership map in a single git log pass.
 * Returns: Map<filePath, Map<email, commitCount>>
 */
function buildOwnershipMap(repoRoot, dirFilter) {
  // Single pass: get all commits with their changed files
  // Format: author email on its own line, then file paths, separated by NUL
  const logOutput = git(
    'log',
    '--format=%x00%ae%x00',
    '--name-only',
    '--diff-filter=ACDMR',
    '--no-merges',
    '--',
    dirFilter ? resolve(dirFilter) : '.'
  );

  if (!logOutput) return new Map();

  /** @type {Map<string, Map<string, number>>} */
  const ownershipMap = new Map();
  /** @type {Set<string>} */
  const allContributors = new Set();

  let currentAuthor = null;

  for (const line of logOutput.split('\n')) {
    if (line.startsWith('\x00') && line.endsWith('\x00')) {
      // Author line: \x00email\x00
      currentAuthor = line.slice(1, -1).trim().toLowerCase();
      if (currentAuthor) allContributors.add(currentAuthor);
    } else if (line.trim() && currentAuthor) {
      // File path line
      const filePath = line.trim();
      // Make relative to repo root
      const absPath = resolve(repoRoot, filePath);
      const relPath = relative(repoRoot, absPath);

      // Skip paths outside repo or binary/lock files we can't do much about
      if (relPath.startsWith('..') || !relPath) continue;

      if (!ownershipMap.has(relPath)) {
        ownershipMap.set(relPath, new Map());
      }
      const fileMap = ownershipMap.get(relPath);
      fileMap.set(currentAuthor, (fileMap.get(currentAuthor) ?? 0) + 1);
    }
  }

  return { ownershipMap, allContributors };
}

// ─── Ownership computation ────────────────────────────────────────────────────

/**
 * For a file's commit map, determine:
 * - owner: email with >threshold commits (or null)
 * - category: orphan | fragile | robust
 * - contributorCount
 */
function computeFileOwnership(commitMap, threshold) {
  const total = [...commitMap.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return { owner: null, category: 'unknown', contributorCount: 0, shares: [] };

  const shares = [...commitMap.entries()]
    .map(([email, count]) => ({ email, count, pct: count / total }))
    .sort((a, b) => b.pct - a.pct);

  const contributorCount = shares.length;
  const top = shares[0];
  const owner = top.pct >= threshold ? top.email : null;

  let category;
  if (contributorCount === 1) category = 'orphan';
  else if (contributorCount <= 3) category = 'fragile';
  else category = 'robust';

  return { owner, category, contributorCount, shares, total };
}

// ─── Directory rollup ─────────────────────────────────────────────────────────

function buildDirMap(ownershipMap, threshold) {
  /** @type {Map<string, { files: number, authorSet: Set<string>, ownerFiles: Map<string, number> }>} */
  const dirMap = new Map();

  for (const [filePath, commitMap] of ownershipMap) {
    const { owner } = computeFileOwnership(commitMap, threshold);
    const parts = filePath.split('/');

    // Roll up into each ancestor directory
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join('/');
      if (!dirMap.has(dir)) {
        dirMap.set(dir, { files: 0, authorSet: new Set(), ownerFiles: new Map() });
      }
      const entry = dirMap.get(dir);
      entry.files++;
      for (const email of commitMap.keys()) entry.authorSet.add(email);
      if (owner) {
        entry.ownerFiles.set(owner, (entry.ownerFiles.get(owner) ?? 0) + 1);
      }
    }
  }

  return dirMap;
}

// ─── Contributor risk ─────────────────────────────────────────────────────────

function computeContributorRisk(ownershipMap, threshold, totalFiles) {
  /** @type {Map<string, { owned: number, critical: Map<string, number> }>} */
  const riskMap = new Map();

  for (const [filePath, commitMap] of ownershipMap) {
    const { owner } = computeFileOwnership(commitMap, threshold);
    if (!owner) continue;

    const dir = filePath.includes('/') ? filePath.split('/').slice(0, -1).join('/') : '.';

    if (!riskMap.has(owner)) {
      riskMap.set(owner, { owned: 0, critical: new Map() });
    }
    const entry = riskMap.get(owner);
    entry.owned++;
    entry.critical.set(dir, (entry.critical.get(dir) ?? 0) + 1);
  }

  return new Map(
    [...riskMap.entries()].map(([email, data]) => [email, {
      ...data,
      pct: data.owned / totalFiles,
    }])
  );
}

// ─── Overall bus factor ───────────────────────────────────────────────────────

/**
 * Bus factor = minimum number of contributors whose removal
 * would cause >20% of owned files to lose their owner.
 *
 * Algorithm: greedily remove the highest-impact contributor
 * until the coverage drops below the threshold.
 */
function computeOverallBusFactor(contributorRisk, totalFiles, coverageThreshold = 0.2) {
  const sorted = [...contributorRisk.entries()]
    .sort((a, b) => b[1].owned - a[1].owned);

  let removed = 0;
  let removedFiles = 0;
  const removedPeople = [];

  for (const [email, data] of sorted) {
    removed++;
    removedFiles += data.owned;
    removedPeople.push(email);
    if (removedFiles / totalFiles >= coverageThreshold) {
      return { busFactor: removed, removedPeople, removedFiles };
    }
  }

  return { busFactor: sorted.length, removedPeople, removedFiles };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function bar(pct, width = 16) {
  const filled = Math.round(pct * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function riskIcon(bf) {
  if (bf <= 1) return noColor ? '[RED]' : '🔴';
  if (bf <= 2) return noColor ? '[YLW]' : '🟡';
  return noColor ? '[GRN]' : '🟢';
}

function pad(str, len) {
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  return str + ' '.repeat(Math.max(0, len - visible.length));
}

function renderHeader(repoName, allContributors, totalFiles, busFactor) {
  const line = '─'.repeat(50);
  console.log();
  console.log(c.bold(`🚌 Bus Factor Analysis`));
  console.log(c.dim(line));
  console.log(`Repository:   ${c.bold(repoName)}`);
  console.log(`Contributors: ${c.bold(String(allContributors.size))} (${[...allContributors].join(', ')})`);
  console.log(`Files analyzed: ${c.bold(String(totalFiles))}`);
  console.log();

  const bfColor = busFactor <= 1 ? c.red : busFactor <= 2 ? c.yellow : c.green;
  console.log(c.bold(`Overall Bus Factor: ${bfColor(String(busFactor))}`));
  console.log(c.dim(`(${busFactor} ${busFactor === 1 ? 'person' : 'people'} leaving would halt this project)`));
  console.log();
}

function renderSPOFs(contributorRisk, spofThreshold, busFactor) {
  const spofs = [...contributorRisk.entries()]
    .filter(([, d]) => d.pct >= spofThreshold)
    .sort((a, b) => b[1].pct - a[1].pct);

  if (spofs.length === 0) {
    console.log(c.green('✅ No single points of failure detected.'));
    console.log();
    return;
  }

  console.log(c.bold(c.red('⚠️  Single Points of Failure:')));
  console.log();

  for (const [email, data] of spofs) {
    const topDirs = [...data.critical.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([d]) => d)
      .join(', ');

    const pctStr = (data.pct * 100).toFixed(1) + '%';
    const impact = data.pct >= 0.5
      ? c.red('Project effectively dead')
      : data.pct >= 0.35
        ? c.yellow('Severe degradation')
        : c.yellow('Significant disruption');

    console.log(`  ${c.bold(email)}`);
    console.log(`  Owns: ${c.bold(String(data.owned))} files (${c.bold(pctStr)} of codebase)`);
    if (topDirs) console.log(`  Critical: ${c.cyan(topDirs)}`);
    console.log(`  Impact if gone: ${impact}`);
    console.log();
  }
}

function renderDirMap(dirMap, threshold, maxDirs = 15) {
  console.log(c.bold('🗂️  Ownership Map:'));
  console.log();

  // Sort by file count desc, limit to maxDirs
  const sorted = [...dirMap.entries()]
    .filter(([, d]) => d.files >= 2)
    .sort((a, b) => b[1].files - a[1].files)
    .slice(0, maxDirs);

  const maxDirLen = Math.max(...sorted.map(([d]) => d.length), 10);

  for (const [dir, data] of sorted) {
    const bf = data.authorSet.size;
    const icon = riskIcon(bf);

    // Find dominant owner
    const topOwner = [...data.ownerFiles.entries()].sort((a, b) => b[1] - a[1])[0];
    const ownerPct = topOwner ? topOwner[1] / data.files : 0;
    const ownerStr = topOwner ? `${(ownerPct * 100).toFixed(0)}% ${topOwner[0].split('@')[0]}` : 'distributed';

    const barStr = topOwner ? bar(ownerPct) : bar(1 / Math.max(bf, 1));
    const dirLabel = pad(c.cyan(dir), maxDirLen + 10);

    console.log(`  ${dirLabel} ${barStr} ${ownerStr.padEnd(24)} ${icon} BF:${bf}`);
  }
  console.log();
}

function renderOrphans(ownershipMap, threshold, topN) {
  const orphans = [];

  for (const [filePath, commitMap] of ownershipMap) {
    const { category, owner } = computeFileOwnership(commitMap, threshold);
    if (category === 'orphan' && owner) {
      orphans.push({ filePath, owner });
    }
  }

  orphans.sort((a, b) => a.filePath.localeCompare(b.filePath));

  console.log(c.bold(`📊 Orphan Files (only 1 contributor ever): ${c.red(String(orphans.length))}`));
  console.log();

  const shown = orphans.slice(0, topN);
  for (const { filePath, owner } of shown) {
    console.log(`  ${c.dim(filePath)} — ${c.yellow(owner.split('@')[0])} only`);
  }

  const remaining = orphans.length - shown.length;
  if (remaining > 0) {
    console.log(`  ${c.dim(`[+${remaining} more — use --top ${orphans.length} to see all]`)}`);
  }
  console.log();
}

function renderContributorMode(email, ownershipMap, threshold, totalFiles) {
  const targetEmail = email.toLowerCase();
  const ownedFiles = [];
  const contributedFiles = [];

  for (const [filePath, commitMap] of ownershipMap) {
    const { owner, shares } = computeFileOwnership(commitMap, threshold);
    const contrib = shares.find(s => s.email === targetEmail);
    if (!contrib) continue;

    if (owner === targetEmail) {
      ownedFiles.push({ filePath, pct: contrib.pct });
    } else {
      contributedFiles.push({ filePath, pct: contrib.pct });
    }
  }

  console.log();
  console.log(c.bold(`🚌 Departure Impact: ${c.red(email)}`));
  console.log(c.dim('─'.repeat(50)));
  console.log();

  const ownedPct = (ownedFiles.length / totalFiles * 100).toFixed(1);
  const contribPct = (contributedFiles.length / totalFiles * 100).toFixed(1);

  console.log(`Files owned (>${(threshold * 100).toFixed(0)}% commits):  ${c.bold(c.red(String(ownedFiles.length)))} (${ownedPct}%)`);
  console.log(`Files contributed to:            ${c.bold(String(contributedFiles.length))} (${contribPct}%)`);
  console.log();

  if (ownedFiles.length > 0) {
    console.log(c.bold(c.red('Files that would lose their owner:')));
    for (const { filePath, pct } of ownedFiles.slice(0, 20)) {
      console.log(`  ${c.dim(filePath)} ${c.yellow((pct * 100).toFixed(0) + '% authored')}`);
    }
    if (ownedFiles.length > 20) {
      console.log(`  ${c.dim(`[+${ownedFiles.length - 20} more]`)}`);
    }
    console.log();
  }

  const verdict = ownedFiles.length / totalFiles >= 0.5
    ? c.red('CRITICAL — project effectively dead without this person')
    : ownedFiles.length / totalFiles >= 0.3
      ? c.yellow('SEVERE — major disruption, many files left unmaintained')
      : ownedFiles.length / totalFiles >= 0.15
        ? c.yellow('SIGNIFICANT — notable disruption')
        : c.green('MANAGEABLE — knowledge distributed well enough');

  console.log(`Verdict: ${verdict}`);
  console.log();
}

function renderRecommendations(busFactor, contributorRisk, spofThreshold) {
  console.log(c.bold('💡 Recommendations:'));
  console.log();

  const spofs = [...contributorRisk.entries()]
    .filter(([, d]) => d.pct >= spofThreshold)
    .sort((a, b) => b[1].pct - a[1].pct);

  const recs = [];

  if (busFactor <= 1) {
    recs.push('Bus factor is CRITICAL (1). This project dies with one person leaving.');
  }

  for (const [email, data] of spofs) {
    const name = email.split('@')[0];
    const topDirs = [...data.critical.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([d]) => d);

    if (topDirs.length > 0) {
      recs.push(`Pair program ${name} on ${topDirs.join(' and ')} immediately`);
      recs.push(`Document ${topDirs[0]}/ before ${name}'s next absence`);
    }
  }

  if (busFactor < 3) {
    recs.push('Target bus factor > 2 — aim for cross-training in the next sprint');
  }

  if (recs.length === 0) {
    recs.push('Knowledge distribution is healthy — maintain with regular cross-training');
  }

  recs.forEach((rec, i) => {
    console.log(`  ${c.bold(String(i + 1) + '.')} ${rec}`);
  });
  console.log();
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  assertGitRepo();

  const repoRoot = getRepoRoot();
  const repoName = getRepoName();

  process.chdir(repoRoot);

  console.log(c.dim('Analyzing git history...'));

  const { ownershipMap, allContributors } = buildOwnershipMap(repoRoot, dirFilter);

  if (ownershipMap.size === 0) {
    console.error(c.yellow('No files found with git history. Is this repo empty?'));
    process.exit(1);
  }

  const totalFiles = ownershipMap.size;
  const contributorRisk = computeContributorRisk(ownershipMap, ownerThreshold, totalFiles);
  const { busFactor } = computeOverallBusFactor(contributorRisk, totalFiles);
  const dirMap = buildDirMap(ownershipMap, ownerThreshold);

  // Clear the "Analyzing..." line
  process.stdout.write('\x1b[1A\x1b[2K');

  if (contributorFilter) {
    renderHeader(repoName, allContributors, totalFiles, busFactor);
    renderContributorMode(contributorFilter, ownershipMap, ownerThreshold, totalFiles);
    return;
  }

  renderHeader(repoName, allContributors, totalFiles, busFactor);
  renderSPOFs(contributorRisk, spofThreshold, busFactor);
  renderDirMap(dirMap, ownerThreshold);
  renderOrphans(ownershipMap, ownerThreshold, topN);
  renderRecommendations(busFactor, contributorRisk, spofThreshold);
}

main().catch(err => {
  console.error(c.red(`Error: ${err.message}`));
  process.exit(1);
});
