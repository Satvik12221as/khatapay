#!/usr/bin/env node
// Generate PNG icons from SVG using sharp
// Run: node scripts/generate-icons.mjs

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
const inputSvg = path.resolve('public/icon-192.svg');
const outputDir = path.resolve('public');

async function generateIcons() {
  const svgBuffer = fs.readFileSync(inputSvg);

  for (const size of sizes) {
    const outputPath = path.join(outputDir, `icon-${size}.png`);
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath);
    console.log(`Generated icon-${size}.png`);
  }

  // Also generate maskable versions (with padding)
  for (const size of sizes) {
    const outputPath = path.join(outputDir, `icon-${size}-maskable.png`);
    await sharp(svgBuffer)
      .resize(Math.floor(size * 0.8), Math.floor(size * 0.8))
      .extend({
        top: Math.floor(size * 0.1),
        bottom: Math.floor(size * 0.1),
        left: Math.floor(size * 0.1),
        right: Math.floor(size * 0.1),
        background: { r: 43, g: 58, b: 140, alpha: 1 }
      })
      .png()
      .toFile(outputPath);
    console.log(`Generated icon-${size}-maskable.png`);
  }

  console.log('All icons generated!');
}

generateIcons().catch(console.error);