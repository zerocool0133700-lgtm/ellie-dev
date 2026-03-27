#!/bin/bash
# Chrome CDP wrapper for agent access
# Delegates to chrome-cdp-skill tools

CHROME_CDP_DIR="/home/ellie/new-stuff/chrome-cdp-skill"

if [ ! -d "$CHROME_CDP_DIR" ]; then
  echo "chrome-cdp-skill not installed at $CHROME_CDP_DIR"
  exit 1
fi

cd "$CHROME_CDP_DIR"
node chrome-cdp.js "$@"
