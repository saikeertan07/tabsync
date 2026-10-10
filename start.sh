#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "=========================================================="
echo "⚡ Starting TabSync Studio for Mac & Android Tablet..."
echo "=========================================================="

# Ensure native mac-input is compiled
if [ ! -f "./mac-input" ]; then
  echo "Compiling native macOS digitizer bridge..."
  swiftc -O mac-input.swift -o mac-input
  chmod +x mac-input
fi

# Open Mac Dashboard in default browser after 1 second
(sleep 1.2 && open "https://localhost:4444") &

# Start server
node server.js
