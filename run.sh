#!/usr/bin/env bash
# Start RepoPulse in the foreground. Extra options are passed on, e.g. ./run.sh --port 9000
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "RepoPulse is not installed yet. Run ./install.sh first."
  exit 1
fi
exec .venv/bin/python -m repopulse serve "$@"
