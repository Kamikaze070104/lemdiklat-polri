#!/bin/bash

echo "=== Build Environment Debug Info ==="
echo "Current directory: $(pwd)"
echo "Filesystem type: $(df -T . | tail -1 | awk '{print $2}')"
echo "Node version: $(node --version)"
echo "NPM version: $(npm --version)"
echo ""
echo "=== Checking RPM tools ==="
which rpmbuild
which fpm
echo ""
echo "=== Checking if on Windows mount ==="
if [[ $(pwd) == /mnt/* ]]; then
  echo "⚠️  WARNING: You are on a Windows mount (/mnt/c/)"
  echo "⚠️  RPM builds will fail on Windows filesystem!"
  echo "⚠️  Please copy project to ~/projects/ first"
  exit 1
else
  echo "✓ Running on native Linux filesystem"
fi
echo ""
echo "=== Starting build with verbose output ==="
DEBUG=electron-builder npm run build:linux
