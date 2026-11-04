#!/bin/bash
set -xeuf -o pipefail

# exit this file if we are not in Codespaces
if [ -z "${CODESPACES}" ]; then
  exit 0
fi

echo "printf \"\n🚀 Welcome to Cal.diy! Try typing 'bun run dx' to get a quick dev environment.\n\"" >> ~/.bashrc