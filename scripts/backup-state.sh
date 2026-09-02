#!/usr/bin/env bash
#
# backup-state.sh — capture everything this panel depends on that isn't in git.
#
# Run before a risky change and again immediately before a switchover. Reads only —
# never touches the running panel, the state dir, or any live session.
#
# Usage:
#   scripts/backup-state.sh                 back up
#   scripts/backup-state.sh --force         back up even with the panel running
#   scripts/backup-state.sh --desktop-copy  also drop a copy on ~/Desktop
#   scripts/backup-state.sh --verify FILE   print an archive's manifest and contents summary
#   scripts/backup-state.sh --help
#
set -euo pipefail

SCRIPT_VERSION="backup-state.sh v1.0.0"

FORCE=0
DESKTOP_COPY=0
VERIFY_TARGET=""

usage() {
  cat <<'EOF'
backup-state.sh — capture everything this panel depends on that isn't in git.

Run before a risky change and again immediately before a switchover. Reads only —
never touches the running panel, the state dir, or any live session.

Usage:
  scripts/backup-state.sh                 back up
  scripts/backup-state.sh --force         back up even with the panel running
  scripts/backup-state.sh --desktop-copy  also drop a copy on ~/Desktop
  scripts/backup-state.sh --verify FILE   print an archive's manifest and contents summary
  scripts/backup-state.sh --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --desktop-copy) DESKTOP_COPY=1; shift ;;
    --verify)
      [[ $# -ge 2 ]] || { echo "error: --verify needs an archive path" >&2; exit 1; }
      VERIFY_TARGET="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unrecognized argument: $1" >&2; usage; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

# Portable file size: macOS's stat wants -f%z, GNU's wants -c%s.
file_size() {
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0
}

# Approximate directory size in bytes, via block-rounded du -sk. Never fails the script —
# a permission hiccup on one file inside a worktree must not abort the whole backup.
dir_size() {
  local kb
  kb=$(du -sk "$1" 2>/dev/null | tail -1 | awk '{print $1}') || true
  echo $(( ${kb:-0} * 1024 ))
}

# `12.4 MB` — decimal, because that's what Finder and `ls -lh` say.
human_size() {
  local bytes="$1"
  if (( bytes < 1000 )); then
    echo "${bytes} B"
  elif (( bytes < 1000000 )); then
    awk -v b="$bytes" 'BEGIN{printf "%.1f KB", b/1000}'
  else
    awk -v b="$bytes" 'BEGIN{printf "%.1f MB", b/1000000}'
  fi
}

# ---------------------------------------------------------------------------
# --verify: read an existing archive's manifest and contents, then exit
# ---------------------------------------------------------------------------

verify_archive() {
  local archive="$1"
  if [[ ! -f "$archive" ]]; then
    echo "error: archive not found: $archive" >&2
    exit 1
  fi

  local tmp
  tmp=$(mktemp -d)

  if ! tar -xzf "$archive" -C "$tmp" MANIFEST.txt 2>/dev/null; then
    echo "error: could not read MANIFEST.txt from $archive — is this a backup-state.sh archive?" >&2
    rm -rf "$tmp"
    exit 1
  fi

  echo "== Manifest: $archive =="
  cat "$tmp/MANIFEST.txt"
  rm -rf "$tmp"
  echo
  echo "== Archive contents (tar -tzf summary) =="
  # Entries are written as `./state-dir/...` etc. (tar -C stage -czf archive .), so strip
  # the leading `./` before matching prefixes.
  local listing
  listing=$(tar -tzf "$archive" | sed 's#^\./##')
  local total
  total=$(echo "$listing" | grep -c . || true)
  echo "Total entries: $total"
  local prefix count
  for prefix in "state-dir/" "claude-settings.json" "launchagent.plist" "claude.json" "repo/"; do
    count=$(echo "$listing" | grep -c "^${prefix}" || true)
    printf '  %-22s %s entries\n' "$prefix" "$count"
  done
}

if [[ -n "$VERIFY_TARGET" ]]; then
  verify_archive "$VERIFY_TARGET"
  exit 0
fi

# ---------------------------------------------------------------------------
# Which install this is
# ---------------------------------------------------------------------------
#
# Resolved from where this script sits, because the install location is the fact — there
# is no marker file and no flag to go looking for. It decides two things below: which
# restart instructions the refusal prints, and (further down) where server/logs.js is.
#
# `pwd -P` for the physical path: a symlinked checkout under a Homebrew prefix would
# otherwise read as an ordinary one, and vice versa.

BREW_FORMULA="foreman-panel"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR_REAL="$(cd "$SCRIPT_DIR" && pwd -P)"

UNDER_HOMEBREW=0
if [[ -n "${HOMEBREW_PREFIX:-}" ]]; then
  BREW_PREFIXES=("$HOMEBREW_PREFIX")
else
  BREW_PREFIXES=("/opt/homebrew" "/usr/local")
fi
for prefix in "${BREW_PREFIXES[@]}"; do
  # The trailing slash on both sides is what stops /usr/local-scratch matching /usr/local.
  if [[ "$SCRIPT_DIR_REAL/" == "$prefix/"* ]]; then
    UNDER_HOMEBREW=1
    break
  fi
done

if [[ "$UNDER_HOMEBREW" -eq 1 ]]; then
  RESTART_STOP="brew services stop $BREW_FORMULA"
  RESTART_START="brew services start $BREW_FORMULA"
else
  RESTART_STOP="npm run stop-panel"
  RESTART_START="npm run install-agent   (or: npm run restart-panel, if it's already installed)"
fi

# ---------------------------------------------------------------------------
# Refuse while the panel is live
# ---------------------------------------------------------------------------
#
# Every store in server/ is a Map behind a ~2s debounced flush. A backup taken from a
# live panel can capture a state dir that is about to be rewritten from memory — the
# copy is of a moment that no longer exists. Detected the way the panel's own boot guard
# does: an HTTP probe of 127.0.0.1:<port>, never a bind attempt (two node servers can
# bind the same port at once and answer differently per interface, which is exactly what
# a bind-attempt check would miss).

PORT="${FOREMAN_PORT:-48770}"

probe_panel_live() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${PORT}/" 2>/dev/null) || code="000"
  [[ "$code" != "000" ]]
}

PANEL_WAS_LIVE=0
if probe_panel_live; then
  PANEL_WAS_LIVE=1
  if [[ "$FORCE" -ne 1 ]]; then
    cat >&2 <<EOF
Refusing to back up: something answered http://127.0.0.1:${PORT}/ — the panel looks like
it's running.

Every store in server/ is a Map behind a debounced flush. A backup taken now can capture
a state dir mid-write: a snapshot of a moment that's about to be overwritten from memory.

To take a real backup:
  1. ${RESTART_STOP}
  2. re-run this script
  3. ${RESTART_START}

Or pass --force to back up anyway — the archive will record that it was taken live.
EOF
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Resolve the five sources
# ---------------------------------------------------------------------------

# The same four rungs server/config.js resolves: $FOREMAN_STATE_DIR, then ~/.foreman if
# it is there, then the directory this project used to use if *that* is there, then
# ~/.foreman. The third rung is a path and not a name anything reads as configuration; it
# is dead on a machine that has never run the older build, and it is here so a backup taken
# before the directory is moved captures the directory the panel is actually reading.
if [[ -n "${FOREMAN_STATE_DIR:-}" ]]; then
  STATE_DIR="$FOREMAN_STATE_DIR"
elif [[ -d "$HOME/.foreman" ]]; then
  STATE_DIR="$HOME/.foreman"
elif [[ -d "$HOME/.agenticdevui" ]]; then
  STATE_DIR="$HOME/.agenticdevui"
else
  STATE_DIR="$HOME/.foreman"
fi
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CLAUDE_JSON="$HOME/.claude.json"

# The git read stays, and stays only for section 5 below — the branch, the sha and the
# uncommitted patch are genuinely checkout-only facts, and saying "not running from inside
# a git checkout" is the right answer when there is no checkout.
REPO_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" || REPO_DIR=""

# server/logs.js is the source of truth for the LaunchAgent label (DEFAULT_AGENT_LABEL,
# overridable by $FOREMAN_AGENT_LABEL). Found **beside this script**, never via git:
# `$SCRIPT_DIR/../server/logs.js` is true in a checkout and equally true under a package
# manager's libexec, where `git rev-parse` answers nothing at all — and an empty answer
# there used to fall silently through to the hardcoded default, which is the wrong label
# for any install that set one, and so the wrong plist (or none) in the archive.
# The fallback stays for a copy of this script carried off on its own.
LOGS_JS="$SCRIPT_DIR/../server/logs.js"
DEFAULT_AGENT_LABEL="dev.foreman.panel"
AGENT_LABEL=""
if [[ -f "$LOGS_JS" ]] && command -v node >/dev/null 2>&1; then
  AGENT_LABEL=$(node -e "
    const { pathToFileURL } = require('url');
    import(pathToFileURL(process.argv[1]).href)
      .then((m) => process.stdout.write(m.AGENT_LABEL || ''))
      .catch(() => {});
  " "$LOGS_JS" 2>/dev/null) || AGENT_LABEL=""
fi
AGENT_LABEL="${AGENT_LABEL:-${FOREMAN_AGENT_LABEL:-$DEFAULT_AGENT_LABEL}}"
PLIST_PATH="$HOME/Library/LaunchAgents/${AGENT_LABEL}.plist"

# ---------------------------------------------------------------------------
# Destination
# ---------------------------------------------------------------------------

BACKUP_DIR="$HOME/foreman-backups"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE_PATH="$BACKUP_DIR/foreman-backup-${TIMESTAMP}.tar.gz"

STAGE="$(mktemp -d)"
cleanup_stage() { rm -rf "$STAGE"; }
trap cleanup_stage EXIT

MANIFEST="$STAGE/MANIFEST.txt"

# stdout summary lines, printed at the end — one per source.
SUMMARY_LINES=()

# ---------------------------------------------------------------------------
# 1. The whole state dir
# ---------------------------------------------------------------------------

KNOWN_STATE_ITEMS=(tasks.json teams worktrees worker-settings worker-logs snapshot.json queue.json pins.json groups.json panes trigger-token)

{
  echo "1. State dir: $STATE_DIR"
} >> "$MANIFEST"

if [[ -d "$STATE_DIR" ]]; then
  mkdir -p "$STAGE/state-dir"
  if ! cp -R "$STATE_DIR/." "$STAGE/state-dir/" 2>>"$STAGE/copy-errors.log"; then
    echo "  (cp reported errors — see notes below; partial copy retained)" >> "$MANIFEST"
  fi

  for item in "${KNOWN_STATE_ITEMS[@]}"; do
    abspath="$STATE_DIR/$item"
    if [[ -e "$abspath" ]]; then
      if [[ -d "$abspath" ]]; then
        size=$(dir_size "$abspath")
        printf '  %-18s captured   (dir)  %s\n' "$item" "$(human_size "$size")" >> "$MANIFEST"
      else
        size=$(file_size "$abspath")
        printf '  %-18s captured          %s\n' "$item" "$(human_size "$size")" >> "$MANIFEST"
      fi
    else
      printf '  %-18s MISSING\n' "$item" >> "$MANIFEST"
    fi
  done

  STATE_TOTAL=$(dir_size "$STATE_DIR")
  echo "  total: $(human_size "$STATE_TOTAL")" >> "$MANIFEST"
  SUMMARY_LINES+=("$(printf '[captured] %-18s %-40s %s' 'State dir' "$STATE_DIR" "$(human_size "$STATE_TOTAL")")")
else
  echo "  MISSING (no such directory)" >> "$MANIFEST"
  SUMMARY_LINES+=("$(printf '[missing]  %-18s %s' 'State dir' "$STATE_DIR")")
fi
echo >> "$MANIFEST"

# ---------------------------------------------------------------------------
# 2. ~/.claude/settings.json
# ---------------------------------------------------------------------------

echo "2. Claude settings: $CLAUDE_SETTINGS" >> "$MANIFEST"
if [[ -f "$CLAUDE_SETTINGS" ]]; then
  cp "$CLAUDE_SETTINGS" "$STAGE/claude-settings.json"
  size=$(file_size "$CLAUDE_SETTINGS")
  echo "  captured   $(human_size "$size")" >> "$MANIFEST"
  SUMMARY_LINES+=("$(printf '[captured] %-18s %-40s %s' 'Claude settings' "$CLAUDE_SETTINGS" "$(human_size "$size")")")
else
  echo "  MISSING" >> "$MANIFEST"
  SUMMARY_LINES+=("$(printf '[missing]  %-18s %s' 'Claude settings' "$CLAUDE_SETTINGS")")
fi
echo >> "$MANIFEST"

# ---------------------------------------------------------------------------
# 3. The LaunchAgent plist
# ---------------------------------------------------------------------------

echo "3. LaunchAgent plist: $PLIST_PATH" >> "$MANIFEST"
if [[ -f "$PLIST_PATH" ]]; then
  cp "$PLIST_PATH" "$STAGE/launchagent.plist"
  size=$(file_size "$PLIST_PATH")
  echo "  captured   $(human_size "$size")" >> "$MANIFEST"
  SUMMARY_LINES+=("$(printf '[captured] %-18s %-40s %s' 'LaunchAgent plist' "$PLIST_PATH" "$(human_size "$size")")")
else
  echo "  MISSING" >> "$MANIFEST"
  SUMMARY_LINES+=("$(printf '[missing]  %-18s %s' 'LaunchAgent plist' "$PLIST_PATH")")
fi
echo >> "$MANIFEST"

# ---------------------------------------------------------------------------
# 4. ~/.claude.json — MCP server registrations, including credentials
# ---------------------------------------------------------------------------

echo "4. Claude MCP config: $CLAUDE_JSON" >> "$MANIFEST"
if [[ -f "$CLAUDE_JSON" ]]; then
  cp "$CLAUDE_JSON" "$STAGE/claude.json"
  size=$(file_size "$CLAUDE_JSON")
  echo "  captured   $(human_size "$size")" >> "$MANIFEST"
  SUMMARY_LINES+=("$(printf '[captured] %-18s %-40s %s' 'Claude MCP config' "$CLAUDE_JSON" "$(human_size "$size")")")
else
  echo "  MISSING" >> "$MANIFEST"
  SUMMARY_LINES+=("$(printf '[missing]  %-18s %s' 'Claude MCP config' "$CLAUDE_JSON")")
fi
echo >> "$MANIFEST"

# ---------------------------------------------------------------------------
# 5. The repo — status, log, branch/sha, and any uncommitted work as a patch
# ---------------------------------------------------------------------------

echo "5. Repo: ${REPO_DIR:-<none — not running from inside a git checkout>}" >> "$MANIFEST"
if [[ -n "$REPO_DIR" ]]; then
  mkdir -p "$STAGE/repo"
  BRANCH=$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null) || BRANCH="<unknown>"
  SHA=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null) || SHA="<unknown>"
  git -C "$REPO_DIR" log -1 > "$STAGE/repo/log.txt" 2>&1 || true
  git -C "$REPO_DIR" status --porcelain -uall > "$STAGE/repo/status.txt" 2>&1 || true
  git -C "$REPO_DIR" diff HEAD > "$STAGE/repo/uncommitted.patch" 2>&1 || true

  # `git diff HEAD` only covers tracked content — a brand-new file nobody has `git add`ed
  # yet has no diff against HEAD at all, so it would silently never make it into the
  # archive. Copy every untracked path (status code `??`) verbatim instead of diffing it.
  # `-z` sidesteps git's path quoting/escaping (CLAUDE.md's diff-vs-status quoting trap).
  UNTRACKED_COUNT=0
  UNTRACKED_BYTES=0
  while IFS= read -r -d '' entry; do
    code="${entry:0:2}"
    rel="${entry:3}"
    [[ "$code" == "??" ]] || continue
    src="$REPO_DIR/$rel"
    [[ -e "$src" ]] || continue
    dest="$STAGE/repo/untracked/$rel"
    mkdir -p "$(dirname "$dest")"
    if [[ -d "$src" ]]; then
      cp -R "$src" "$dest"
    else
      cp -p "$src" "$dest"
    fi
    UNTRACKED_COUNT=$((UNTRACKED_COUNT + 1))
  done < <(git -C "$REPO_DIR" status --porcelain -uall -z 2>/dev/null)
  if [[ -d "$STAGE/repo/untracked" ]]; then
    UNTRACKED_BYTES=$(dir_size "$STAGE/repo/untracked")
  fi

  DIRTY_COUNT=$(wc -l < "$STAGE/repo/status.txt" | tr -d ' ')
  DIFF_SIZE=$(file_size "$STAGE/repo/uncommitted.patch")

  {
    echo "  branch: $BRANCH"
    echo "  sha: $SHA"
    echo "  dirty files: $DIRTY_COUNT"
    if [[ "$DIFF_SIZE" -gt 0 ]]; then
      echo "  tracked-file diff: captured, $(human_size "$DIFF_SIZE")"
    else
      echo "  tracked-file diff: none"
    fi
    if [[ "$UNTRACKED_COUNT" -gt 0 ]]; then
      echo "  untracked files: $UNTRACKED_COUNT captured verbatim, $(human_size "$UNTRACKED_BYTES")"
    else
      echo "  untracked files: none"
    fi
    if [[ "$DIFF_SIZE" -eq 0 && "$UNTRACKED_COUNT" -eq 0 ]]; then
      echo "  uncommitted work: none (working tree matches HEAD)"
    fi
  } >> "$MANIFEST"

  SUMMARY_LINES+=("$(printf '[captured] %-18s branch %s @ %s, %s dirty file(s)' 'Repo' "$BRANCH" "${SHA:0:12}" "$DIRTY_COUNT")")
else
  echo "  MISSING (script is not inside a git checkout)" >> "$MANIFEST"
  SUMMARY_LINES+=("$(printf '[missing]  %-18s not inside a git checkout' 'Repo')")
fi
echo >> "$MANIFEST"

# ---------------------------------------------------------------------------
# Manifest header (written last, prepended — everything above already knows its facts)
# ---------------------------------------------------------------------------

HEADER="$STAGE/MANIFEST-header.txt"
{
  echo "Foreman state backup"
  echo "===================="
  echo "Script: $SCRIPT_VERSION"
  echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Hostname: $(hostname)"
  if [[ "$PANEL_WAS_LIVE" -eq 1 ]]; then
    echo "Taken while the panel was live (--force): yes"
  else
    echo "Taken while the panel was live (--force): no"
  fi
  echo
  echo "Sources"
  echo "-------"
  echo
} > "$HEADER"

cat "$HEADER" "$MANIFEST" > "$STAGE/MANIFEST.txt.tmp"
mv "$STAGE/MANIFEST.txt.tmp" "$MANIFEST"
rm -f "$HEADER"
[[ -s "$STAGE/copy-errors.log" ]] && { echo >> "$MANIFEST"; echo "Copy errors (state dir):" >> "$MANIFEST"; cat "$STAGE/copy-errors.log" >> "$MANIFEST"; }

# ---------------------------------------------------------------------------
# Archive it
# ---------------------------------------------------------------------------

tar -C "$STAGE" -czf "$ARCHIVE_PATH" .
chmod 600 "$ARCHIVE_PATH"

if [[ "$DESKTOP_COPY" -eq 1 ]]; then
  DESKTOP_PATH="$HOME/Desktop/$(basename "$ARCHIVE_PATH")"
  cp "$ARCHIVE_PATH" "$DESKTOP_PATH"
  chmod 600 "$DESKTOP_PATH"
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

ARCHIVE_SIZE=$(file_size "$ARCHIVE_PATH")

echo "Archive: $ARCHIVE_PATH"
echo "Size: $(human_size "$ARCHIVE_SIZE")"
echo
for line in "${SUMMARY_LINES[@]}"; do
  echo "  $line"
done
if [[ "$DESKTOP_COPY" -eq 1 ]]; then
  echo
  echo "Also copied to: $DESKTOP_PATH"
fi
