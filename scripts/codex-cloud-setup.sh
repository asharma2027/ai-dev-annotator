#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "Preparing ai-dev-annotator for Codex cloud..."
echo "Node: $(node --version)"
echo "npm: $(npm --version)"

has_npm_dependencies() {
  local package_file="$1"
  node - "$package_file" <<'NODE'
const fs = require('fs');
const packageFile = process.argv[2];
const text = fs.readFileSync(packageFile, 'utf8');
if (!text.trim()) process.exit(2);
const pkg = JSON.parse(text);
const dependencyKeys = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
process.exit(dependencyKeys.some((key) => pkg[key] && Object.keys(pkg[key]).length > 0) ? 0 : 1);
NODE
}

valid_package_json() {
  local package_file="$1"
  node - "$package_file" <<'NODE'
const fs = require('fs');
const packageFile = process.argv[2];
const text = fs.readFileSync(packageFile, 'utf8');
if (!text.trim()) process.exit(2);
JSON.parse(text);
NODE
}

install_npm_project() {
  local dir="$1"
  local label="$2"
  local package_file="$dir/package.json"
  local lock_file="$dir/package-lock.json"

  if [[ ! -f "$package_file" ]]; then
    echo "Skipping $label: no package.json found."
    return 0
  fi

  if ! valid_package_json "$package_file"; then
    echo "Skipping $label: $package_file is not readable as JSON in this checkout."
    return 0
  fi

  if [[ "$dir" == "." ]] && [[ ! -f "$lock_file" ]] && ! has_npm_dependencies "$package_file"; then
    echo "Skipping root npm install: package.json has scripts only."
    return 0
  fi

  echo "Installing $label dependencies..."
  if [[ -f "$lock_file" ]]; then
    npm --prefix "$dir" ci --no-audit --no-fund || npm --prefix "$dir" install --no-audit --no-fund
  else
    npm --prefix "$dir" install --package-lock=false --no-audit --no-fund
  fi
}

install_npm_project "." "root"
install_npm_project "desktop-app" "desktop app"
install_npm_project "infra/worker" "Cloudflare Worker"

npm run check
