#!/usr/bin/env bash
set -euo pipefail

root="${HERMES_ROOT:-/opt/data}"
plugin_name="hermes-ai-office"
plugin_source="${AI_OFFICE_PLUGIN_SOURCE:-${root}/plugins/${plugin_name}}"
hermes_bin="${HERMES_BIN:-/opt/hermes/.venv/bin/hermes}"

if [[ ! -d "${plugin_source}" ]]; then
  echo "AI Office plugin source not found: ${plugin_source}" >&2
  exit 2
fi
if [[ ! -x "${hermes_bin}" ]]; then
  echo "Hermes executable not found: ${hermes_bin}" >&2
  exit 2
fi

profiles_root="${root}/profiles"
if [[ ! -d "${profiles_root}" ]]; then
  exit 0
fi

for profile_dir in "${profiles_root}"/*; do
  [[ -d "${profile_dir}" && -f "${profile_dir}/config.yaml" ]] || continue
  mkdir -p "${profile_dir}/plugins"
  target="${profile_dir}/plugins/${plugin_name}"
  if [[ -e "${target}" && ! -L "${target}" ]]; then
    echo "Refusing to replace profile-local plugin directory: ${target}" >&2
    exit 3
  fi
  ln -sfn "${plugin_source}" "${target}"
  HERMES_HOME="${profile_dir}" "${hermes_bin}" plugins enable "${plugin_name}" >/dev/null
  echo "enabled ${plugin_name} for $(basename "${profile_dir}")"
done
