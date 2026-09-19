#!/usr/bin/env bash
# Official prerequisites: https://learn.chatgpt.com/docs/sandboxing
set -euo pipefail
sudo apt-get update
sudo apt-get install -y bubblewrap
if ! bwrap --ro-bind / / --dev /dev --proc /proc --unshare-user -- /bin/true; then
  . /etc/os-release
  if [[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]]; then
    sudo apt-get install -y apparmor-profiles apparmor-utils
    sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
    sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
  fi
fi
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-user -- /bin/true
printf 'bubblewrap user-namespace startup verified.\n'
