#!/bin/bash

echo "=== Fixing Vite Build Issues ==="

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run this from project root."
    exit 1
fi

echo "✓ Project root confirmed"

# Check if index.tsx exists
if [ ! -f "index.tsx" ]; then
    echo "❌ Error: index.tsx not found!"
    exit 1
fi

echo "✓ index.tsx exists"

# Fix file permissions
echo "🔧 Fixing file permissions..."
chmod -R u+rwX,go+rX .

# Clean old build artifacts
echo "🧹 Cleaning old build artifacts..."
rm -rf dist/ release/ node_modules/.vite

# Verify node_modules
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
else
    echo "✓ node_modules exists"
fi

echo ""
echo "✅ Fixes applied! Now running build..."
echo ""

npm run build
