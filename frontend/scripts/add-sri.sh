#!/bin/bash
# Add SRI integrity attributes to dist/index.html after build
# This ensures users can verify the JS/CSS hasn't been tampered with
set -e

HTML="dist/index.html"
if [ ! -f "$HTML" ]; then echo "dist/index.html not found"; exit 1; fi

# Process script tags: src="/assets/xxx.js" → add integrity
for file in dist/assets/*.js; do
  basename=$(basename "$file")
  hash=$(openssl dgst -sha384 -binary "$file" | openssl base64 -A)
  sri="sha384-$hash"
  # Add integrity attribute to matching script tag
  sed -i '' "s|src=\"/assets/$basename\"|src=\"/assets/$basename\" integrity=\"$sri\"|g" "$HTML"
done

# Process CSS link tags: href="/assets/xxx.css" → add integrity
for file in dist/assets/*.css; do
  basename=$(basename "$file")
  hash=$(openssl dgst -sha384 -binary "$file" | openssl base64 -A)
  sri="sha384-$hash"
  sed -i '' "s|href=\"/assets/$basename\"|href=\"/assets/$basename\" integrity=\"$sri\"|g" "$HTML"
done

echo "SRI hashes added to $HTML"
